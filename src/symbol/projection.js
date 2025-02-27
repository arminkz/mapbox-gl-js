// @flow

import Point from '@mapbox/point-geometry';

import {mat2, mat4, vec4} from 'gl-matrix';
import * as symbolSize from './symbol_size.js';
import {addDynamicAttributes} from '../data/bucket/symbol_bucket.js';
import type Projection from '../geo/projection/projection.js';
import type Painter from '../render/painter.js';
import type Transform from '../geo/transform.js';
import type SymbolBucket from '../data/bucket/symbol_bucket.js';
import type {
    GlyphOffsetArray,
    SymbolLineVertexArray,
    SymbolDynamicLayoutArray
} from '../data/array_types.js';
import type {Mat4, Vec4} from 'gl-matrix';

import {WritingMode} from '../symbol/shaping.js';
import {CanonicalTileID, OverscaledTileID} from '../source/tile_id.js';
import {calculateGlobeLabelMatrix} from '../geo/projection/globe_util.js';
export {updateLineLabels, hideGlyphs, getLabelPlaneMatrix, getGlCoordMatrix, project, projectVector, getPerspectiveRatio, placeFirstAndLastGlyph, placeGlyphAlongLine, xyTransformMat4};

const FlipState = {
    unknown: 0,
    flipRequired: 1,
    flipNotRequired: 2
};

const maxTangent = Math.tan(85 * Math.PI / 180);

/*
 * # Overview of coordinate spaces
 *
 * ## Tile coordinate spaces
 * Each label has an anchor. Some labels have corresponding line geometries.
 * The points for both anchors and lines are stored in tile units. Each tile has it's own
 * coordinate space going from (0, 0) at the top left to (EXTENT, EXTENT) at the bottom right.
 *
 * ## GL coordinate space
 * At the end of everything, the vertex shader needs to produce a position in GL coordinate space,
 * which is (-1, 1) at the top left and (1, -1) in the bottom right.
 *
 * ## Map pixel coordinate spaces
 * Each tile has a pixel coordinate space. It's just the tile units scaled so that one unit is
 * whatever counts as 1 pixel at the current zoom.
 * This space is used for pitch-alignment=map, rotation-alignment=map
 *
 * ## Rotated map pixel coordinate spaces
 * Like the above, but rotated so axis of the space are aligned with the viewport instead of the tile.
 * This space is used for pitch-alignment=map, rotation-alignment=viewport
 *
 * ## Viewport pixel coordinate space
 * (0, 0) is at the top left of the canvas and (pixelWidth, pixelHeight) is at the bottom right corner
 * of the canvas. This space is used for pitch-alignment=viewport
 *
 *
 * # Vertex projection
 * It goes roughly like this:
 * 1. project the anchor and line from tile units into the correct label coordinate space
 *      - map pixel space           pitch-alignment=map         rotation-alignment=map
 *      - rotated map pixel space   pitch-alignment=map         rotation-alignment=viewport
 *      - viewport pixel space      pitch-alignment=viewport    rotation-alignment=*
 * 2. if the label follows a line, find the point along the line that is the correct distance from the anchor.
 * 3. add the glyph's corner offset to the point from step 3
 * 4. convert from the label coordinate space to gl coordinates
 *
 * For horizontal labels we want to do step 1 in the shader for performance reasons (no cpu work).
 *      This is what `u_label_plane_matrix` is used for.
 * For labels aligned with lines we have to steps 1 and 2 on the cpu since we need access to the line geometry.
 *      This is what `updateLineLabels(...)` does.
 *      Since the conversion is handled on the cpu we just set `u_label_plane_matrix` to an identity matrix.
 *
 * Steps 3 and 4 are done in the shaders for all labels.
 */

/*
 * Returns a matrix for converting from tile units to the correct label coordinate space.
 */
function getLabelPlaneMatrix(posMatrix: Float32Array,
                             tileID: CanonicalTileID,
                             pitchWithMap: boolean,
                             rotateWithMap: boolean,
                             transform: Transform,
                             pixelsToTileUnits: Float32Array): Float32Array {
    const m = mat4.create();
    if (pitchWithMap) {
        if (transform.projection.name === 'globe') {
            mat4.multiply(m, m, calculateGlobeLabelMatrix(transform, tileID));

        } else {
            const s = mat2.invert([], pixelsToTileUnits);
            m[0] = s[0];
            m[1] = s[1];
            m[4] = s[2];
            m[5] = s[3];
        }
        if (!rotateWithMap) {
            mat4.rotateZ(m, m, transform.angle);
        }
    } else {
        mat4.multiply(m, transform.labelPlaneMatrix, posMatrix);
    }
    return m;
}

/*
 * Returns a matrix for converting from the correct label coordinate space to gl coords.
 */
function getGlCoordMatrix(posMatrix: Float32Array,
                          tileID: CanonicalTileID,
                          pitchWithMap: boolean,
                          rotateWithMap: boolean,
                          transform: Transform,
                          pixelsToTileUnits: Float32Array) {
    if (pitchWithMap) {
        if (transform.projection.name === 'globe') {
            const m = getLabelPlaneMatrix(posMatrix, tileID, pitchWithMap, rotateWithMap, transform, pixelsToTileUnits);
            mat4.invert(m, m);
            mat4.multiply(m, posMatrix, m);
            return m;
        } else {
            const m = mat4.clone(posMatrix);
            const s = mat4.identity([]);
            s[0] = pixelsToTileUnits[0];
            s[1] = pixelsToTileUnits[1];
            s[4] = pixelsToTileUnits[2];
            s[5] = pixelsToTileUnits[3];
            mat4.multiply(m, m, s);
            if (!rotateWithMap) {
                mat4.rotateZ(m, m, -transform.angle);
            }
            return m;
        }
    } else {
        return transform.glCoordMatrix;
    }
}

function project(point: Point, matrix: Mat4, elevation: number = 0) {
    const pos = [point.x, point.y, elevation, 1];
    if (elevation) {
        vec4.transformMat4(pos, pos, matrix);
    } else {
        xyTransformMat4(pos, pos, matrix);
    }
    const w = pos[3];
    return {
        point: new Point(pos[0] / w, pos[1] / w),
        signedDistanceFromCamera: w
    };
}

function projectVector(point: [number, number, number], matrix: Mat4) {
    const pos = [point[0], point[1], point[2], 1];
    vec4.transformMat4(pos, pos, matrix);
    const w = pos[3];
    return {
        point: new Point(pos[0] / w, pos[1] / w),
        signedDistanceFromCamera: w
    };
}

function getPerspectiveRatio(cameraToCenterDistance: number, signedDistanceFromCamera: number): number {
    return Math.min(0.5 + 0.5 * (cameraToCenterDistance / signedDistanceFromCamera), 1.5);
}

function isVisible(anchorPos: [number, number, number, number],
                   clippingBuffer: [number, number]) {
    const x = anchorPos[0] / anchorPos[3];
    const y = anchorPos[1] / anchorPos[3];
    const inPaddedViewport = (
        x >= -clippingBuffer[0] &&
        x <= clippingBuffer[0] &&
        y >= -clippingBuffer[1] &&
        y <= clippingBuffer[1]);
    return inPaddedViewport;
}

/*
 *  Update the `dynamicLayoutVertexBuffer` for the buffer with the correct glyph positions for the current map view.
 *  This is only run on labels that are aligned with lines. Horizontal labels are handled entirely in the shader.
 */
function updateLineLabels(bucket: SymbolBucket,
                          posMatrix: Float32Array,
                          painter: Painter,
                          isText: boolean,
                          labelPlaneMatrix: Float32Array,
                          glCoordMatrix: Float32Array,
                          pitchWithMap: boolean,
                          keepUpright: boolean,
                          getElevation: ?((p: Point) => Array<number>),
                          tileID: OverscaledTileID) {

    const tr = painter.transform;
    const sizeData = isText ? bucket.textSizeData : bucket.iconSizeData;
    const partiallyEvaluatedSize = symbolSize.evaluateSizeForZoom(sizeData, painter.transform.zoom);

    const clippingBuffer = [256 / painter.width * 2 + 1, 256 / painter.height * 2 + 1];

    const dynamicLayoutVertexArray = isText ?
        bucket.text.dynamicLayoutVertexArray :
        bucket.icon.dynamicLayoutVertexArray;
    dynamicLayoutVertexArray.clear();

    const lineVertexArray = bucket.lineVertexArray;
    const placedSymbols = isText ? bucket.text.placedSymbolArray : bucket.icon.placedSymbolArray;

    const aspectRatio = painter.transform.width / painter.transform.height;

    let useVertical = false;

    for (let s = 0; s < placedSymbols.length; s++) {
        const symbol: any = placedSymbols.get(s);

        // Normally, the 'Horizontal|Vertical' writing mode is followed by a 'Vertical' counterpart, this
        // is not true for 'Vertical' only line labels. For this case, we'll have to overwrite the 'useVertical'
        // status before further checks.
        if (symbol.writingMode === WritingMode.vertical && !useVertical) {
            if (s === 0 || placedSymbols.get(s - 1).writingMode !== WritingMode.horizontal) {
                useVertical = true;
            }
        }

        // Don't do calculations for vertical glyphs unless the previous symbol was horizontal
        // and we determined that vertical glyphs were necessary.
        // Also don't do calculations for symbols that are collided and fully faded out
        if ((symbol.hidden || symbol.writingMode === WritingMode.vertical) && !useVertical) {
            hideGlyphs(symbol.numGlyphs, dynamicLayoutVertexArray);
            continue;
        }
        // Awkward... but we're counting on the paired "vertical" symbol coming immediately after its horizontal counterpart
        useVertical = false;

        // Project tile anchor to globe anchor
        const tileAnchorPoint = new Point(symbol.tileAnchorX, symbol.tileAnchorY);
        const elevation = getElevation ? getElevation(tileAnchorPoint) : [0, 0, 0];
        const projectedAnchor = tr.projection.projectTilePoint(tileAnchorPoint.x, tileAnchorPoint.y, tileID.canonical);
        const elevatedAnchor = [projectedAnchor.x + elevation[0], projectedAnchor.y + elevation[1], projectedAnchor.z + elevation[2]];
        const anchorPos = [...elevatedAnchor, 1.0];

        vec4.transformMat4(anchorPos, anchorPos, posMatrix);

        // Don't bother calculating the correct point for invisible labels.
        if (!isVisible(anchorPos, clippingBuffer)) {
            hideGlyphs(symbol.numGlyphs, dynamicLayoutVertexArray);
            continue;
        }
        const cameraToAnchorDistance = anchorPos[3];
        const perspectiveRatio = getPerspectiveRatio(painter.transform.cameraToCenterDistance, cameraToAnchorDistance);

        const fontSize = symbolSize.evaluateSizeForFeature(sizeData, partiallyEvaluatedSize, symbol);
        const pitchScaledFontSize = pitchWithMap ? fontSize / perspectiveRatio : fontSize * perspectiveRatio;

        const labelPlaneAnchorPoint = project(new Point(elevatedAnchor[0], elevatedAnchor[1]), labelPlaneMatrix, elevatedAnchor[2]);

        // Skip labels behind the camera
        if (labelPlaneAnchorPoint.signedDistanceFromCamera <= 0.0) {
            hideGlyphs(symbol.numGlyphs, dynamicLayoutVertexArray);
            continue;
        }

        let projectionCache = {};

        const getElevationForPlacement = pitchWithMap ? null : getElevation; // When pitchWithMap, we're projecting to scaled tile coordinate space: there is no need to get elevation as it doesn't affect projection.
        const placeUnflipped: any = placeGlyphsAlongLine(symbol, pitchScaledFontSize, false /*unflipped*/, keepUpright, posMatrix, labelPlaneMatrix, glCoordMatrix,
            bucket.glyphOffsetArray, lineVertexArray, dynamicLayoutVertexArray, labelPlaneAnchorPoint.point, tileAnchorPoint, projectionCache, aspectRatio, getElevationForPlacement, tr.projection, tileID);

        useVertical = placeUnflipped.useVertical;

        if (getElevationForPlacement && placeUnflipped.needsFlipping) projectionCache = {}; // Truncated points should be recalculated.
        if (placeUnflipped.notEnoughRoom || useVertical ||
            (placeUnflipped.needsFlipping &&
             placeGlyphsAlongLine(symbol, pitchScaledFontSize, true /*flipped*/, keepUpright, posMatrix, labelPlaneMatrix, glCoordMatrix,
                 bucket.glyphOffsetArray, lineVertexArray, dynamicLayoutVertexArray, labelPlaneAnchorPoint.point, tileAnchorPoint, projectionCache, aspectRatio, getElevationForPlacement, tr.projection, tileID).notEnoughRoom)) {
            hideGlyphs(symbol.numGlyphs, dynamicLayoutVertexArray);
        }
    }

    if (isText) {
        bucket.text.dynamicLayoutVertexBuffer.updateData(dynamicLayoutVertexArray);
    } else {
        bucket.icon.dynamicLayoutVertexBuffer.updateData(dynamicLayoutVertexArray);
    }
}

function placeFirstAndLastGlyph(fontScale: number, glyphOffsetArray: GlyphOffsetArray, lineOffsetX: number, lineOffsetY: number, flip: boolean, anchorPoint: Point, tileAnchorPoint: Point, symbol: any, lineVertexArray: SymbolLineVertexArray, labelPlaneMatrix: Float32Array, projectionCache: any, getElevation: ?((p: Point) => Array<number>), returnPathInTileCoords: ?boolean, projection: Projection, tileID: OverscaledTileID) {
    const glyphEndIndex = symbol.glyphStartIndex + symbol.numGlyphs;
    const lineStartIndex = symbol.lineStartIndex;
    const lineEndIndex = symbol.lineStartIndex + symbol.lineLength;

    const firstGlyphOffset = glyphOffsetArray.getoffsetX(symbol.glyphStartIndex);
    const lastGlyphOffset = glyphOffsetArray.getoffsetX(glyphEndIndex - 1);

    const firstPlacedGlyph = placeGlyphAlongLine(fontScale * firstGlyphOffset, lineOffsetX, lineOffsetY, flip, anchorPoint, tileAnchorPoint, symbol.segment,
        lineStartIndex, lineEndIndex, lineVertexArray, labelPlaneMatrix, projectionCache, getElevation, returnPathInTileCoords, true, projection, tileID);
    if (!firstPlacedGlyph)
        return null;

    const lastPlacedGlyph = placeGlyphAlongLine(fontScale * lastGlyphOffset, lineOffsetX, lineOffsetY, flip, anchorPoint, tileAnchorPoint, symbol.segment,
        lineStartIndex, lineEndIndex, lineVertexArray, labelPlaneMatrix, projectionCache, getElevation, returnPathInTileCoords, true, projection, tileID);
    if (!lastPlacedGlyph)
        return null;

    return {first: firstPlacedGlyph, last: lastPlacedGlyph};
}

// Check in the glCoordinate space, the rough estimation of angle between the text line and the Y axis.
// If the angle if less or equal to 5 degree, then keep the text glyphs unflipped even if it is required.
function isInFlipRetainRange(firstPoint, lastPoint, aspectRatio) {
    const deltaY = lastPoint.y - firstPoint.y;
    const deltaX = (lastPoint.x - firstPoint.x) * aspectRatio;
    if (deltaX === 0.0) {
        return true;
    }
    const absTangent = Math.abs(deltaY / deltaX);
    return (absTangent > maxTangent);
}

function requiresOrientationChange(symbol, firstPoint, lastPoint, aspectRatio) {
    if (symbol.writingMode === WritingMode.horizontal) {
        // On top of choosing whether to flip, choose whether to render this version of the glyphs or the alternate
        // vertical glyphs. We can't just filter out vertical glyphs in the horizontal range because the horizontal
        // and vertical versions can have slightly different projections which could lead to angles where both or
        // neither showed.
        const rise = Math.abs(lastPoint.y - firstPoint.y);
        const run = Math.abs(lastPoint.x - firstPoint.x) * aspectRatio;
        if (rise > run) {
            return {useVertical: true};
        }
    }
    // Check if flipping is required for "verticalOnly" case.
    if (symbol.writingMode === WritingMode.vertical) {
        return (firstPoint.y < lastPoint.y) ? {needsFlipping: true} : null;
    }

    // symbol's flipState stores the flip decision from the previous frame, and that
    // decision is reused when the symbol is in the retain range.
    if (symbol.flipState !== FlipState.unknown && isInFlipRetainRange(firstPoint, lastPoint, aspectRatio)) {
        return (symbol.flipState === FlipState.flipRequired) ? {needsFlipping: true} : null;
    }

    // Check if flipping is required for "horizontal" case.
    return (firstPoint.x > lastPoint.x) ? {needsFlipping: true} : null;
}

function placeGlyphsAlongLine(symbol, fontSize, flip, keepUpright, posMatrix, labelPlaneMatrix, glCoordMatrix, glyphOffsetArray, lineVertexArray, dynamicLayoutVertexArray, anchorPoint, tileAnchorPoint, projectionCache, aspectRatio, getElevation, projection, tileID) {
    const fontScale = fontSize / 24;
    const lineOffsetX = symbol.lineOffsetX * fontScale;
    const lineOffsetY = symbol.lineOffsetY * fontScale;

    let placedGlyphs;
    if (symbol.numGlyphs > 1) {
        const glyphEndIndex = symbol.glyphStartIndex + symbol.numGlyphs;
        const lineStartIndex = symbol.lineStartIndex;
        const lineEndIndex = symbol.lineStartIndex + symbol.lineLength;

        // Place the first and the last glyph in the label first, so we can figure out
        // the overall orientation of the label and determine whether it needs to be flipped in keepUpright mode
        const firstAndLastGlyph = placeFirstAndLastGlyph(fontScale, glyphOffsetArray, lineOffsetX, lineOffsetY, flip, anchorPoint, tileAnchorPoint, symbol, lineVertexArray, labelPlaneMatrix, projectionCache, getElevation, false, projection, tileID);
        if (!firstAndLastGlyph) {
            return {notEnoughRoom: true};
        }
        const firstPoint = project(firstAndLastGlyph.first.point, glCoordMatrix).point;
        const lastPoint = project(firstAndLastGlyph.last.point, glCoordMatrix).point;

        if (keepUpright && !flip) {
            const orientationChange = requiresOrientationChange(symbol, firstPoint, lastPoint, aspectRatio);
            symbol.flipState = orientationChange && orientationChange.needsFlipping ? FlipState.flipRequired : FlipState.flipNotRequired;
            if (orientationChange) {
                return orientationChange;
            }
        }

        placedGlyphs = [firstAndLastGlyph.first];
        for (let glyphIndex = symbol.glyphStartIndex + 1; glyphIndex < glyphEndIndex - 1; glyphIndex++) {
            // Since first and last glyph fit on the line, we're sure that the rest of the glyphs can be placed
            // $FlowFixMe
            placedGlyphs.push(placeGlyphAlongLine(fontScale * glyphOffsetArray.getoffsetX(glyphIndex), lineOffsetX, lineOffsetY, flip, anchorPoint, tileAnchorPoint, symbol.segment,
                lineStartIndex, lineEndIndex, lineVertexArray, labelPlaneMatrix, projectionCache, getElevation, false, false, projection, tileID));
        }
        placedGlyphs.push(firstAndLastGlyph.last);
    } else {
        // Only a single glyph to place
        // So, determine whether to flip based on projected angle of the line segment it's on
        if (keepUpright && !flip) {
            const a = project(tileAnchorPoint, posMatrix).point;
            const tileVertexIndex = (symbol.lineStartIndex + symbol.segment + 1);
            // $FlowFixMe
            const tileSegmentEnd = new Point(lineVertexArray.getx(tileVertexIndex), lineVertexArray.gety(tileVertexIndex));
            const projectedVertex = project(tileSegmentEnd, posMatrix);
            // We know the anchor will be in the viewport, but the end of the line segment may be
            // behind the plane of the camera, in which case we can use a point at any arbitrary (closer)
            // point on the segment.
            const b = (projectedVertex.signedDistanceFromCamera > 0) ?
                projectedVertex.point :
                projectTruncatedLineSegment(tileAnchorPoint, tileSegmentEnd, a, 1, posMatrix, undefined, projection, tileID.canonical);

            const orientationChange = requiresOrientationChange(symbol, a, b, aspectRatio);
            symbol.flipState = orientationChange && orientationChange.needsFlipping ? FlipState.flipRequired : FlipState.flipNotRequired;
            if (orientationChange) {
                return orientationChange;
            }
        }
        // $FlowFixMe
        const singleGlyph = placeGlyphAlongLine(fontScale * glyphOffsetArray.getoffsetX(symbol.glyphStartIndex), lineOffsetX, lineOffsetY, flip, anchorPoint, tileAnchorPoint, symbol.segment,
            symbol.lineStartIndex, symbol.lineStartIndex + symbol.lineLength, lineVertexArray, labelPlaneMatrix, projectionCache, getElevation, false, false, projection, tileID);
        if (!singleGlyph)
            return {notEnoughRoom: true};

        placedGlyphs = [singleGlyph];
    }

    for (const glyph: any of placedGlyphs) {
        addDynamicAttributes(dynamicLayoutVertexArray, glyph.point, glyph.angle);
    }
    return {};
}

function elevatePointAndProject(p: Point, tileID: CanonicalTileID, posMatrix: Float32Array, projection: Projection, getElevation: ?((p: Point) => Array<number>)) {
    const point = projection.projectTilePoint(p.x, p.y, tileID);
    if (!getElevation) {
        return project(point, posMatrix, point.z);
    }

    const elevation = getElevation(p);
    return project(new Point(point.x + elevation[0], point.y + elevation[1]), posMatrix, point.z + elevation[2]);
}

function projectTruncatedLineSegment(previousTilePoint: Point, currentTilePoint: Point, previousProjectedPoint: Point, minimumLength: number, projectionMatrix: Float32Array, getElevation: ?((p: Point) => Array<number>), projection: Projection, tileID: CanonicalTileID) {
    // We are assuming "previousTilePoint" won't project to a point within one unit of the camera plane
    // If it did, that would mean our label extended all the way out from within the viewport to a (very distant)
    // point near the plane of the camera. We wouldn't be able to render the label anyway once it crossed the
    // plane of the camera.
    const unitVertex = previousTilePoint.add(previousTilePoint.sub(currentTilePoint)._unit());
    const projectedUnitVertex = elevatePointAndProject(unitVertex, tileID, projectionMatrix, projection, getElevation).point;
    const projectedUnitSegment = previousProjectedPoint.sub(projectedUnitVertex);

    return previousProjectedPoint.add(projectedUnitSegment._mult(minimumLength / projectedUnitSegment.mag()));
}

function interpolate(p1, p2, a) {
    const b = 1 - a;
    return new Point(p1.x * b + p2.x * a, p1.y * b + p2.y * a);
}

function placeGlyphAlongLine(offsetX: number,
                             lineOffsetX: number,
                             lineOffsetY: number,
                             flip: boolean,
                             anchorPoint: Point,
                             tileAnchorPoint: Point,
                             anchorSegment: number,
                             lineStartIndex: number,
                             lineEndIndex: number,
                             lineVertexArray: SymbolLineVertexArray,
                             labelPlaneMatrix: Float32Array,
                             projectionCache: {[_: number]: Point},
                             getElevation: ?((p: Point) => Array<number>),
                             returnPathInTileCoords: ?boolean,
                             endGlyph: ?boolean,
                             reprojection: Projection,
                             tileID: OverscaledTileID) {

    const combinedOffsetX = flip ?
        offsetX - lineOffsetX :
        offsetX + lineOffsetX;

    let dir = combinedOffsetX > 0 ? 1 : -1;

    let angle = 0;
    if (flip) {
        // The label needs to be flipped to keep text upright.
        // Iterate in the reverse direction.
        dir *= -1;
        angle = Math.PI;
    }

    if (dir < 0) angle += Math.PI;

    let currentIndex = dir > 0 ?
        lineStartIndex + anchorSegment :
        lineStartIndex + anchorSegment + 1;

    let current = anchorPoint;
    let prev = anchorPoint;
    let distanceToPrev = 0;
    let currentSegmentDistance = 0;
    const absOffsetX = Math.abs(combinedOffsetX);
    const pathVertices = [];
    const tilePath = [];
    let currentVertex = tileAnchorPoint;

    const previousTilePoint = () => {
        const previousLineVertexIndex = currentIndex - dir;
        return distanceToPrev === 0 ?
            tileAnchorPoint :
            new Point(lineVertexArray.getx(previousLineVertexIndex), lineVertexArray.gety(previousLineVertexIndex));
    };

    const getTruncatedLineSegment = () => {
        return projectTruncatedLineSegment(previousTilePoint(), currentVertex, prev, absOffsetX - distanceToPrev + 1, labelPlaneMatrix, getElevation, reprojection, tileID.canonical);
    };

    while (distanceToPrev + currentSegmentDistance <= absOffsetX) {
        currentIndex += dir;

        // offset does not fit on the projected line
        if (currentIndex < lineStartIndex || currentIndex >= lineEndIndex)
            return null;

        prev = current;
        pathVertices.push(current);
        if (returnPathInTileCoords) tilePath.push(currentVertex || previousTilePoint());

        current = projectionCache[currentIndex];
        if (current === undefined) {
            currentVertex = new Point(lineVertexArray.getx(currentIndex), lineVertexArray.gety(currentIndex));
            const projection = elevatePointAndProject(currentVertex, tileID.canonical, labelPlaneMatrix, reprojection, getElevation);
            if (projection.signedDistanceFromCamera > 0) {
                current = projectionCache[currentIndex] = projection.point;
            } else {
                // The vertex is behind the plane of the camera, so we can't project it
                // Instead, we'll create a vertex along the line that's far enough to include the glyph
                // Don't cache because the new vertex might not be far enough out for future glyphs on the same segment
                current = getTruncatedLineSegment();
            }
        } else {
            currentVertex = null; // null stale data
        }

        distanceToPrev += currentSegmentDistance;
        currentSegmentDistance = prev.dist(current);
    }

    if (endGlyph && getElevation) {
        // For terrain, always truncate end points in order to handle terrain curvature.
        // If previously truncated, on signedDistanceFromCamera < 0, don't do it.
        // Cache as end point. The cache is cleared if there is need for flipping in updateLineLabels.
        currentVertex = currentVertex || new Point(lineVertexArray.getx(currentIndex), lineVertexArray.gety(currentIndex));
        projectionCache[currentIndex] = current = (projectionCache[currentIndex] === undefined) ? current : getTruncatedLineSegment();
        currentSegmentDistance = prev.dist(current);
    }

    // The point is on the current segment. Interpolate to find it.
    const segmentInterpolationT = (absOffsetX - distanceToPrev) / currentSegmentDistance;
    const prevToCurrent = current.sub(prev);
    const p = prevToCurrent.mult(segmentInterpolationT)._add(prev);

    // offset the point from the line to text-offset and icon-offset
    if (lineOffsetY) p._add(prevToCurrent._unit()._perp()._mult(lineOffsetY * dir));

    const segmentAngle = angle + Math.atan2(current.y - prev.y, current.x - prev.x);

    pathVertices.push(p);
    if (returnPathInTileCoords) {
        currentVertex = currentVertex || new Point(lineVertexArray.getx(currentIndex), lineVertexArray.gety(currentIndex));
        const prevVertex = tilePath.length > 0 ? tilePath[tilePath.length - 1] : currentVertex;
        tilePath.push(interpolate(prevVertex, currentVertex, segmentInterpolationT));
    }

    return {
        point: p,
        angle: segmentAngle,
        path: pathVertices,
        tilePath
    };
}

const hiddenGlyphAttributes = new Float32Array([-Infinity, -Infinity, 0, -Infinity, -Infinity, 0, -Infinity, -Infinity, 0, -Infinity, -Infinity, 0]);

// Hide them by moving them offscreen. We still need to add them to the buffer
// because the dynamic buffer is paired with a static buffer that doesn't get updated.
function hideGlyphs(num: number, dynamicLayoutVertexArray: SymbolDynamicLayoutArray) {
    for (let i = 0; i < num; i++) {
        const offset = dynamicLayoutVertexArray.length;
        dynamicLayoutVertexArray.resize(offset + 4);
        // Since all hidden glyphs have the same attributes, we can build up the array faster with a single call to Float32Array.set
        // for each set of four vertices, instead of calling addDynamicAttributes for each vertex.
        dynamicLayoutVertexArray.float32.set(hiddenGlyphAttributes, offset * 3);
    }
}

// For line label layout, we're not using z output and our w input is always 1
// This custom matrix transformation ignores those components to make projection faster
function xyTransformMat4(out: Vec4, a: Vec4, m: Mat4) {
    const x = a[0], y = a[1];
    out[0] = m[0] * x + m[4] * y + m[12];
    out[1] = m[1] * x + m[5] * y + m[13];
    out[3] = m[3] * x + m[7] * y + m[15];
    return out;
}
