// @flow
import {mat4, vec3, vec4} from 'gl-matrix';
import {Ray} from '../../util/primitives.js';
import EXTENT from '../../data/extent.js';
import LngLat from '../lng_lat.js';
import {degToRad, radToDeg, getColumn, shortestAngle} from '../../util/util.js';
import MercatorCoordinate, {
    lngFromMercatorX,
    latFromMercatorY,
    mercatorZfromAltitude,
    mercatorXfromLng,
    mercatorYfromLat
} from '../mercator_coordinate.js';
import Mercator from './mercator.js';
import Point from '@mapbox/point-geometry';
import {farthestPixelDistanceOnPlane, farthestPixelDistanceOnSphere} from './far_z.js';
import {number as interpolate} from '../../style-spec/util/interpolate.js';
import {
    GLOBE_RADIUS,
    latLngToECEF,
    globeTileBounds,
    globeNormalizeECEF,
    globeDenormalizeECEF,
    globeECEFUnitsToPixelScale,
    globeECEFNormalizationScale,
    globeToMercatorTransition
} from './globe_util.js';

import type Transform from '../transform.js';
import type {ElevationScale} from './projection.js';
import type {Vec3} from 'gl-matrix';
import type {ProjectionSpecification} from '../../style-spec/types.js';
import type {CanonicalTileID, UnwrappedTileID} from '../../source/tile_id.js';

const GLOBE_METERS_TO_ECEF = mercatorZfromAltitude(1, 0.0) * 2.0 * GLOBE_RADIUS * Math.PI;

export default class Globe extends Mercator {

    constructor(options: ProjectionSpecification) {
        super(options);
        this.requiresDraping = true;
        this.supportsWorldCopies = false;
        this.supportsFog = false;
        this.zAxisUnit = "pixels";
        this.unsupportedLayers = ['fill-extrusion', 'debug', 'custom'];
    }

    projectTilePoint(x: number, y: number, id: CanonicalTileID): {x: number, y: number, z: number} {
        const tiles = Math.pow(2.0, id.z);
        const mx = (x / EXTENT + id.x) / tiles;
        const my = (y / EXTENT + id.y) / tiles;
        const lat = latFromMercatorY(my);
        const lng = lngFromMercatorX(mx);
        const pos = latLngToECEF(lat, lng);

        const bounds = globeTileBounds(id);
        const normalizationMatrix = globeNormalizeECEF(bounds);
        vec3.transformMat4(pos, pos, normalizationMatrix);

        return {x: pos[0], y: pos[1], z: pos[2]};
    }

    locationPoint(tr: Transform, lngLat: LngLat): Point {
        const pos = latLngToECEF(lngLat.lat, lngLat.lng);
        const up = vec3.normalize([], pos);

        const elevation = tr.elevation ?
            tr.elevation.getAtPointOrZero(tr.locationCoordinate(lngLat), tr._centerAltitude) :
            tr._centerAltitude;

        const upScale = mercatorZfromAltitude(1, 0) * EXTENT * elevation;
        vec3.scaleAndAdd(pos, pos, up, upScale);
        const matrix = mat4.identity(new Float64Array(16));
        mat4.multiply(matrix, tr.pixelMatrix, tr.globeMatrix);
        vec3.transformMat4(pos, pos, matrix);

        return new Point(pos[0], pos[1]);
    }

    pixelsPerMeter(lat: number, worldSize: number): number {
        return mercatorZfromAltitude(1, 0) * worldSize;
    }

    createTileMatrix(tr: Transform, worldSize: number, id: UnwrappedTileID): Float64Array {
        const decode = globeDenormalizeECEF(globeTileBounds(id.canonical));
        return mat4.multiply(new Float64Array(16), tr.globeMatrix, decode);
    }

    createInversionMatrix(tr: Transform, id: CanonicalTileID): Float32Array {
        const {center, worldSize} = tr;
        const ecefUnitsToPixels = globeECEFUnitsToPixelScale(worldSize);
        const matrix = mat4.identity(new Float64Array(16));
        const encode = globeNormalizeECEF(globeTileBounds(id));
        mat4.multiply(matrix, matrix, encode);
        mat4.rotateY(matrix, matrix, degToRad(center.lng));
        mat4.rotateX(matrix, matrix, degToRad(center.lat));
        mat4.scale(matrix, matrix, [1.0 / ecefUnitsToPixels, 1.0 / ecefUnitsToPixels, 1.0]);

        const ecefUnitsToMercatorPixels = tr.pixelsPerMeter / mercatorZfromAltitude(1.0, center.lat) / EXTENT;

        mat4.scale(matrix, matrix, [ecefUnitsToMercatorPixels, ecefUnitsToMercatorPixels, 1.0]);

        return Float32Array.from(matrix);
    }

    pointCoordinate(tr: Transform, x: number, y: number, _: number): MercatorCoordinate {
        const point0 = [x, y, 0, 1];
        const point1 = [x, y, 1, 1];

        vec4.transformMat4(point0, point0, tr.pixelMatrixInverse);
        vec4.transformMat4(point1, point1, tr.pixelMatrixInverse);

        vec4.scale(point0, point0, 1 / point0[3]);
        vec4.scale(point1, point1, 1 / point1[3]);

        const p0p1 = vec3.sub([], point1, point0);
        const direction = vec3.normalize([], p0p1);

        // Compute globe origo in world space
        const m = tr.globeMatrix;
        const globeCenter = [m[12], m[13], m[14]];
        const radius = tr.worldSize / (2.0 * Math.PI);

        const pointOnGlobe = [];
        const ray = new Ray(point0, direction);

        ray.closestPointOnSphere(globeCenter, radius, pointOnGlobe);

        // Transform coordinate axes to find lat & lng of the position
        const xa = vec3.normalize([], getColumn(m, 0));
        const ya = vec3.normalize([], getColumn(m, 1));
        const za = vec3.normalize([], getColumn(m, 2));

        const xp = vec3.dot(xa, pointOnGlobe);
        const yp = vec3.dot(ya, pointOnGlobe);
        const zp = vec3.dot(za, pointOnGlobe);

        const lat = radToDeg(Math.asin(-yp / radius));
        let lng = radToDeg(Math.atan2(xp, zp));

        // Check that the returned longitude angle is not wrapped
        lng = tr.center.lng + shortestAngle(tr.center.lng, lng);

        const mx = mercatorXfromLng(lng);
        const my = mercatorYfromLat(lat);

        return new MercatorCoordinate(mx, my);
    }

    farthestPixelDistance(tr: Transform): number {
        const pixelsPerMeter = this.pixelsPerMeter(tr.center.lat, tr.worldSize);
        const globePixelDistance = farthestPixelDistanceOnSphere(tr, pixelsPerMeter);
        const t = globeToMercatorTransition(tr.zoom);
        if (t > 0.0) {
            const mercatorPixelsPerMeter = mercatorZfromAltitude(1, tr.center.lat) * tr.worldSize;
            const mercatorPixelDistance = farthestPixelDistanceOnPlane(tr, mercatorPixelsPerMeter);
            return interpolate(globePixelDistance, mercatorPixelDistance, t);
        }
        return globePixelDistance;
    }

    upVector(id: CanonicalTileID, x: number, y: number): Vec3 {
        const tiles = 1 << id.z;
        const mercX = (x / EXTENT + id.x) / tiles;
        const mercY = (y / EXTENT + id.y) / tiles;
        return latLngToECEF(latFromMercatorY(mercY), lngFromMercatorX(mercX), 1.0);
    }

    upVectorScale(id: CanonicalTileID, latitude: number, worldSize: number): ElevationScale {
        const pixelsPerMeterAtLat = mercatorZfromAltitude(1, latitude) * worldSize;
        return {metersToTile: GLOBE_METERS_TO_ECEF * globeECEFNormalizationScale(globeTileBounds(id)), metersToLabelSpace: pixelsPerMeterAtLat};
    }
}
