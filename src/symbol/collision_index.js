// @flow

import Point from '@mapbox/point-geometry';
import clipLine from './clip_line.js';
import PathInterpolator from './path_interpolator.js';

import * as intersectionTests from '../util/intersection_tests.js';
import Grid from './grid_index.js';
import {mat4, vec4} from 'gl-matrix';
import ONE_EM from '../symbol/one_em.js';
import {FOG_SYMBOL_CLIPPING_THRESHOLD, getFogOpacityAtTileCoord} from '../style/fog_helpers.js';
import assert from 'assert';
import {OverscaledTileID} from '../source/tile_id.js';

import * as projection from '../symbol/projection.js';
import type Transform from '../geo/transform.js';
import type {SingleCollisionBox} from '../data/bucket/symbol_bucket.js';
import type {
    GlyphOffsetArray,
    SymbolLineVertexArray
} from '../data/array_types.js';
import type {FogState} from '../style/fog_helpers.js';
import type {Vec3, Mat4} from 'gl-matrix';

// When a symbol crosses the edge that causes it to be included in
// collision detection, it will cause changes in the symbols around
// it. This constant specifies how many pixels to pad the edge of
// the viewport for collision detection so that the bulk of the changes
// occur offscreen. Making this constant greater increases label
// stability, but it's expensive.
const viewportPadding = 100;

/**
 * A collision index used to prevent symbols from overlapping. It keep tracks of
 * where previous symbols have been placed and is used to check if a new
 * symbol overlaps with any previously added symbols.
 *
 * There are two steps to insertion: first placeCollisionBox/Circles checks if
 * there's room for a symbol, then insertCollisionBox/Circles actually puts the
 * symbol in the index. The two step process allows paired symbols to be inserted
 * together even if they overlap.
 *
 * @private
 */
class CollisionIndex {
    grid: Grid;
    ignoredGrid: Grid;
    transform: Transform;
    pitchfactor: number;
    screenRightBoundary: number;
    screenBottomBoundary: number;
    gridRightBoundary: number;
    gridBottomBoundary: number;
    fogState: ?FogState;

    constructor(
        transform: Transform,
        fogState: ?FogState,
        grid: Grid = new Grid(transform.width + 2 * viewportPadding, transform.height + 2 * viewportPadding, 25),
        ignoredGrid: Grid = new Grid(transform.width + 2 * viewportPadding, transform.height + 2 * viewportPadding, 25)
    ) {
        this.transform = transform;

        this.grid = grid;
        this.ignoredGrid = ignoredGrid;
        this.pitchfactor = Math.cos(transform._pitch) * transform.cameraToCenterDistance;

        this.screenRightBoundary = transform.width + viewportPadding;
        this.screenBottomBoundary = transform.height + viewportPadding;
        this.gridRightBoundary = transform.width + 2 * viewportPadding;
        this.gridBottomBoundary = transform.height + 2 * viewportPadding;
        this.fogState = fogState;
    }

    placeCollisionBox(scale: number, collisionBox: SingleCollisionBox, shift: Point, allowOverlap: boolean, textPixelRatio: number, posMatrix: Mat4, collisionGroupPredicate?: any): { box: Array<number>, offscreen: boolean, occluded: boolean } {
        assert(!this.transform.elevation || collisionBox.elevation !== undefined);

        let anchorX = collisionBox.projectedAnchorX;
        let anchorY = collisionBox.projectedAnchorY;
        let anchorZ = collisionBox.projectedAnchorZ;

        // Apply elevation vector to the anchor point
        const elevation = collisionBox.elevation;
        const tileID = collisionBox.tileID;
        if (elevation && tileID) {
            const up = this.transform.projection.upVector(tileID.canonical, collisionBox.tileAnchorX, collisionBox.tileAnchorY);
            const upScale = this.transform.projection.upVectorScale(tileID.canonical, this.transform.center.lat, this.transform.worldSize).metersToTile;

            anchorX += up[0] * elevation * upScale;
            anchorY += up[1] * elevation * upScale;
            anchorZ += up[2] * elevation * upScale;
        }

        const checkOcclusion = this.transform.projection.name === 'globe' || !!elevation || this.transform.pitch > 0;
        const projectedPoint = this.projectAndGetPerspectiveRatio(posMatrix, [anchorX, anchorY, anchorZ], collisionBox.tileID, checkOcclusion);

        const tileToViewport = textPixelRatio * projectedPoint.perspectiveRatio;
        const tlX = (collisionBox.x1 * scale + shift.x - collisionBox.padding) * tileToViewport + projectedPoint.point.x;
        const tlY = (collisionBox.y1 * scale + shift.y - collisionBox.padding) * tileToViewport + projectedPoint.point.y;
        const brX = (collisionBox.x2 * scale + shift.x + collisionBox.padding) * tileToViewport + projectedPoint.point.x;
        const brY = (collisionBox.y2 * scale + shift.y + collisionBox.padding) * tileToViewport + projectedPoint.point.y;
        // Clip at 10 times the distance of the map center or, said otherwise, when the label
        // would be drawn at 10% the size of the features around it without scaling. Refer:
        // https://github.com/mapbox/mapbox-gl-native/wiki/Text-Rendering#perspective-scaling
        // 0.55 === projection.getPerspectiveRatio(camera_to_center, camera_to_center * 10)
        const minPerspectiveRatio = 0.55;
        const isClipped = projectedPoint.perspectiveRatio <= minPerspectiveRatio || projectedPoint.occluded;

        if (!this.isInsideGrid(tlX, tlY, brX, brY) ||
            (!allowOverlap && this.grid.hitTest(tlX, tlY, brX, brY, collisionGroupPredicate)) ||
            isClipped) {
            return {
                box: [],
                offscreen: false,
                occluded: projectedPoint.occluded
            };
        }

        return {
            box: [tlX, tlY, brX, brY],
            offscreen: this.isOffscreen(tlX, tlY, brX, brY),
            occluded: false
        };
    }

    placeCollisionCircles(allowOverlap: boolean,
                          symbol: any,
                          lineVertexArray: SymbolLineVertexArray,
                          glyphOffsetArray: GlyphOffsetArray,
                          fontSize: number,
                          posMatrix: Float32Array,
                          labelPlaneMatrix: Float32Array,
                          labelToScreenMatrix?: Mat4,
                          showCollisionCircles: boolean,
                          pitchWithMap: boolean,
                          collisionGroupPredicate?: any,
                          circlePixelDiameter: number,
                          textPixelPadding: number,
                          tileID: OverscaledTileID): { circles: Array<number>, offscreen: boolean, collisionDetected: boolean, occluded: boolean } {
        const placedCollisionCircles = [];
        const elevation = this.transform.elevation;
        const getElevation = elevation ? elevation.getAtTileOffsetFunc(tileID, this.transform.center.lat, this.transform.worldSize, this.transform.projection) : (_ => [0, 0, 0]);
        const tileUnitAnchorPoint = new Point(symbol.tileAnchorX, symbol.tileAnchorY);
        const projectedAnchor = this.transform.projection.projectTilePoint(symbol.tileAnchorX, symbol.tileAnchorY, tileID.canonical);
        const anchorElevation = getElevation(tileUnitAnchorPoint);
        const elevatedAnchor = [projectedAnchor.x + anchorElevation[0], projectedAnchor.y + anchorElevation[1], projectedAnchor.z + anchorElevation[2]];
        const checkOcclusion = this.transform.projection.name === 'globe' || !!elevation || this.transform.pitch > 0;
        const screenAnchorPoint = this.projectAndGetPerspectiveRatio(posMatrix, [elevatedAnchor[0], elevatedAnchor[1], elevatedAnchor[2]], tileID, checkOcclusion);
        const {perspectiveRatio} = screenAnchorPoint;
        const labelPlaneFontSize = pitchWithMap ? fontSize / perspectiveRatio : fontSize * perspectiveRatio;
        const labelPlaneFontScale = labelPlaneFontSize / ONE_EM;
        const labelPlaneAnchorPoint = projection.project(new Point(elevatedAnchor[0], elevatedAnchor[1]), labelPlaneMatrix, elevatedAnchor[2]).point;

        const projectionCache = {};
        const lineOffsetX = symbol.lineOffsetX * labelPlaneFontScale;
        const lineOffsetY = symbol.lineOffsetY * labelPlaneFontScale;

        const firstAndLastGlyph = screenAnchorPoint.signedDistanceFromCamera > 0 ? projection.placeFirstAndLastGlyph(
            labelPlaneFontScale,
            glyphOffsetArray,
            lineOffsetX,
            lineOffsetY,
            /*flip*/ false,
            labelPlaneAnchorPoint,
            tileUnitAnchorPoint,
            symbol,
            lineVertexArray,
            labelPlaneMatrix,
            projectionCache,
            elevation && !pitchWithMap ? getElevation : null, // pitchWithMap: no need to sample elevation as it has no effect when projecting using scale/rotate to tile space labelPlaneMatrix.
            pitchWithMap && !!elevation,
            this.transform.projection,
            tileID
        ) : null;

        let collisionDetected = false;
        let inGrid = false;
        let entirelyOffscreen = true;

        if (firstAndLastGlyph && !screenAnchorPoint.occluded) {
            const radius = circlePixelDiameter * 0.5 * perspectiveRatio + textPixelPadding;
            const screenPlaneMin = new Point(-viewportPadding, -viewportPadding);
            const screenPlaneMax = new Point(this.screenRightBoundary, this.screenBottomBoundary);
            const interpolator = new PathInterpolator();

            // Construct a projected path from projected line vertices. Anchor points are ignored and removed
            const first = firstAndLastGlyph.first;
            const last = firstAndLastGlyph.last;

            let projectedPath = [];
            for (let i = first.path.length - 1; i >= 1; i--) {
                projectedPath.push(first.path[i]);
            }
            for (let i = 1; i < last.path.length; i++) {
                projectedPath.push(last.path[i]);
            }
            assert(projectedPath.length >= 2);

            // Tolerate a slightly longer distance than one diameter between two adjacent circles
            const circleDist = radius * 2.5;

            // The path might need to be converted into screen space if a pitched map is used as the label space
            if (labelToScreenMatrix) {
                assert(pitchWithMap);
                const screenSpacePath = elevation ?
                    projectedPath.map((p, index) => {
                        const elevation = getElevation(index < first.path.length - 1 ? first.tilePath[first.path.length - 1 - index] : last.tilePath[index - first.path.length + 2]);
                        return projection.project(p, labelToScreenMatrix, elevation[2]);
                    }) :
                    projectedPath.map(p => projection.project(p, labelToScreenMatrix));

                // Do not try to place collision circles if even of the points is behind the camera.
                // This is a plausible scenario with big camera pitch angles
                if (screenSpacePath.some(point => point.signedDistanceFromCamera <= 0)) {
                    projectedPath = [];
                } else {
                    projectedPath = screenSpacePath.map(p => p.point);
                }
            }

            let segments = [];

            if (projectedPath.length > 0) {
                // Quickly check if the path is fully inside or outside of the padded collision region.
                // For overlapping paths we'll only create collision circles for the visible segments
                const minPoint = projectedPath[0].clone();
                const maxPoint = projectedPath[0].clone();

                for (let i = 1; i < projectedPath.length; i++) {
                    minPoint.x = Math.min(minPoint.x, projectedPath[i].x);
                    minPoint.y = Math.min(minPoint.y, projectedPath[i].y);
                    maxPoint.x = Math.max(maxPoint.x, projectedPath[i].x);
                    maxPoint.y = Math.max(maxPoint.y, projectedPath[i].y);
                }

                if (minPoint.x >= screenPlaneMin.x && maxPoint.x <= screenPlaneMax.x &&
                    minPoint.y >= screenPlaneMin.y && maxPoint.y <= screenPlaneMax.y) {
                    // Quad fully visible
                    segments = [projectedPath];
                } else if (maxPoint.x < screenPlaneMin.x || minPoint.x > screenPlaneMax.x ||
                    maxPoint.y < screenPlaneMin.y || minPoint.y > screenPlaneMax.y) {
                    // Not visible
                    segments = [];
                } else {
                    segments = clipLine([projectedPath], screenPlaneMin.x, screenPlaneMin.y, screenPlaneMax.x, screenPlaneMax.y);
                }
            }

            for (const seg of segments) {
                // interpolate positions for collision circles. Add a small padding to both ends of the segment
                assert(seg.length > 0);
                interpolator.reset(seg, radius * 0.25);

                let numCircles = 0;

                if (interpolator.length <= 0.5 * radius) {
                    numCircles = 1;
                } else {
                    numCircles = Math.ceil(interpolator.paddedLength / circleDist) + 1;
                }

                for (let i = 0; i < numCircles; i++) {
                    const t = i / Math.max(numCircles - 1, 1);
                    const circlePosition = interpolator.lerp(t);

                    // add viewport padding to the position and perform initial collision check
                    const centerX = circlePosition.x + viewportPadding;
                    const centerY = circlePosition.y + viewportPadding;

                    placedCollisionCircles.push(centerX, centerY, radius, 0);

                    const x1 = centerX - radius;
                    const y1 = centerY - radius;
                    const x2 = centerX + radius;
                    const y2 = centerY + radius;

                    entirelyOffscreen = entirelyOffscreen && this.isOffscreen(x1, y1, x2, y2);
                    inGrid = inGrid || this.isInsideGrid(x1, y1, x2, y2);

                    if (!allowOverlap) {
                        if (this.grid.hitTestCircle(centerX, centerY, radius, collisionGroupPredicate)) {
                            // Don't early exit if we're showing the debug circles because we still want to calculate
                            // which circles are in use
                            collisionDetected = true;
                            if (!showCollisionCircles) {
                                return {
                                    circles: [],
                                    offscreen: false,
                                    collisionDetected,
                                    occluded: false
                                };
                            }
                        }
                    }
                }
            }
        }

        return {
            circles: ((!showCollisionCircles && collisionDetected) || !inGrid) ? [] : placedCollisionCircles,
            offscreen: entirelyOffscreen,
            collisionDetected,
            occluded: screenAnchorPoint.occluded
        };
    }

    /**
     * Because the geometries in the CollisionIndex are an approximation of the shape of
     * symbols on the map, we use the CollisionIndex to look up the symbol part of
     * `queryRenderedFeatures`.
     *
     * @private
     */
    queryRenderedSymbols(viewportQueryGeometry: Array<Point>) {
        if (viewportQueryGeometry.length === 0 || (this.grid.keysLength() === 0 && this.ignoredGrid.keysLength() === 0)) {
            return {};
        }

        const query = [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const point of viewportQueryGeometry) {
            const gridPoint = new Point(point.x + viewportPadding, point.y + viewportPadding);
            minX = Math.min(minX, gridPoint.x);
            minY = Math.min(minY, gridPoint.y);
            maxX = Math.max(maxX, gridPoint.x);
            maxY = Math.max(maxY, gridPoint.y);
            query.push(gridPoint);
        }

        const features = this.grid.query(minX, minY, maxX, maxY)
            .concat(this.ignoredGrid.query(minX, minY, maxX, maxY));

        const seenFeatures = {};
        const result = {};

        for (const feature of features) {
            const featureKey = feature.key;
            // Skip already seen features.
            if (seenFeatures[featureKey.bucketInstanceId] === undefined) {
                seenFeatures[featureKey.bucketInstanceId] = {};
            }
            if (seenFeatures[featureKey.bucketInstanceId][featureKey.featureIndex]) {
                continue;
            }

            // Check if query intersects with the feature box
            // "Collision Circles" for line labels are treated as boxes here
            // Since there's no actual collision taking place, the circle vs. square
            // distinction doesn't matter as much, and box geometry is easier
            // to work with.
            const bbox = [
                new Point(feature.x1, feature.y1),
                new Point(feature.x2, feature.y1),
                new Point(feature.x2, feature.y2),
                new Point(feature.x1, feature.y2)
            ];
            if (!intersectionTests.polygonIntersectsPolygon(query, bbox)) {
                continue;
            }

            seenFeatures[featureKey.bucketInstanceId][featureKey.featureIndex] = true;
            if (result[featureKey.bucketInstanceId] === undefined) {
                result[featureKey.bucketInstanceId] = [];
            }
            result[featureKey.bucketInstanceId].push(featureKey.featureIndex);
        }

        return result;
    }

    insertCollisionBox(collisionBox: Array<number>, ignorePlacement: boolean, bucketInstanceId: number, featureIndex: number, collisionGroupID: number) {
        const grid = ignorePlacement ? this.ignoredGrid : this.grid;

        const key = {bucketInstanceId, featureIndex, collisionGroupID};
        grid.insert(key, collisionBox[0], collisionBox[1], collisionBox[2], collisionBox[3]);
    }

    insertCollisionCircles(collisionCircles: Array<number>, ignorePlacement: boolean, bucketInstanceId: number, featureIndex: number, collisionGroupID: number) {
        const grid = ignorePlacement ? this.ignoredGrid : this.grid;

        const key = {bucketInstanceId, featureIndex, collisionGroupID};
        for (let k = 0; k < collisionCircles.length; k += 4) {
            grid.insertCircle(key, collisionCircles[k], collisionCircles[k + 1], collisionCircles[k + 2]);
        }
    }

    projectAndGetPerspectiveRatio(posMatrix: Mat4, point: Vec3, tileID: ?OverscaledTileID, checkOcclusion: boolean) {
        const p = [point[0], point[1], point[2], 1];
        let behindFog = false;
        if (point[2] || this.transform.pitch > 0) {
            vec4.transformMat4(p, p, posMatrix);
            if (this.fogState && tileID) {
                const fogOpacity = getFogOpacityAtTileCoord(this.fogState, point[0], point[1], point[2], tileID.toUnwrapped(), this.transform);
                behindFog = fogOpacity > FOG_SYMBOL_CLIPPING_THRESHOLD;
            }
        } else {
            projection.xyTransformMat4(p, p, posMatrix);
        }
        const a = new Point(
            (((p[0] / p[3] + 1) / 2) * this.transform.width) + viewportPadding,
            (((-p[1] / p[3] + 1) / 2) * this.transform.height) + viewportPadding
        );

        return {
            point: a,
            // See perspective ratio comment in symbol_sdf.vertex
            // We're doing collision detection in viewport space so we need
            // to scale down boxes in the distance
            perspectiveRatio: Math.min(0.5 + 0.5 * (this.transform.cameraToCenterDistance / p[3]), 1.5),
            signedDistanceFromCamera: p[3],
            occluded: (checkOcclusion && p[2] > p[3]) || behindFog // Occluded by the far plane
        };
    }

    isOffscreen(x1: number, y1: number, x2: number, y2: number) {
        return x2 < viewportPadding || x1 >= this.screenRightBoundary || y2 < viewportPadding || y1 > this.screenBottomBoundary;
    }

    isInsideGrid(x1: number, y1: number, x2: number, y2: number) {
        return x2 >= 0 && x1 < this.gridRightBoundary && y2 >= 0 && y1 < this.gridBottomBoundary;
    }

    /*
    * Returns a matrix for transforming collision shapes to viewport coordinate space.
    * Use this function to render e.g. collision circles on the screen.
    *   example transformation: clipPos = glCoordMatrix * viewportMatrix * circle_pos
    */
    getViewportMatrix(): Mat4 {
        const m = mat4.identity([]);
        mat4.translate(m, m, [-viewportPadding, -viewportPadding, 0.0]);
        return m;
    }
}

export default CollisionIndex;
