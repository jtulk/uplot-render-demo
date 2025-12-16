// Worker that generates x/y points as typed arrays
// Optimized for performance, memory usage, and maintainability

import type { DataFormat, WorkerRequest, WorkerResponse } from "../types";

// Type the worker context properly (avoid Window.postMessage signature conflicts)
interface WorkerGlobalScope {
	onmessage: ((this: Worker, ev: MessageEvent) => void) | null;
	postMessage(message: unknown, transfer?: Transferable[]): void;
}
declare const self: WorkerGlobalScope;

// ============================================================================
// Configuration
// ============================================================================

const MAX_POINTS = 10_000_000;
const MAX_LINES = 1000;
const MAX_BYTES = 512 * 1024 * 1024; // 512MB soft cap

// ============================================================================
// Fast PRNG (xorshift32) - ~2-3x faster than Math.random()
// ============================================================================

let rngState = 1;

function seedRng(seed: number): void {
	rngState = seed | 0 || 1;
}

/** Returns value in [0, 1) */
function random(): number {
	rngState ^= rngState << 13;
	rngState ^= rngState >>> 17;
	rngState ^= rngState << 5;
	return (rngState >>> 0) / 4294967296;
}

/** Returns value in [-0.5, 0.5) */
function randomCentered(): number {
	return random() - 0.5;
}

// ============================================================================
// Curve functions - each returns a raw value before amplitude/offset adjustment
// ============================================================================

type CurveFunction = (t: number, noise: number) => number;
type RandomWalkFunction = (
	t: number,
	noise: number,
	state: Float32Array,
	lineIdx: number,
) => number;

const curveFunctions: Record<string, CurveFunction | RandomWalkFunction> = {
	loss: (t: number, noise: number): number =>
		Math.exp(-t * 3) * (0.85 + noise * 0.3),

	sin: (t: number, noise: number): number =>
		Math.sin(t * Math.PI * 4) * (0.85 + noise * 0.3),

	accuracy: (t: number, noise: number): number =>
		Math.min(1, 0.5 + t * 0.4 + Math.sin(t * Math.PI * 2) * 0.1 + noise * 0.08),

	linear: (t: number, noise: number): number => t * 100 + noise * 5,

	exponential: (t: number, noise: number): number =>
		Math.exp(t * 4) * 10 + noise * 20,

	logarithmic: (t: number, noise: number): number =>
		Math.log1p(t * 10) * 2 + noise * 0.5,

	cosine: (t: number, noise: number): number =>
		Math.cos(t * Math.PI * 4) * (0.85 + noise * 0.3),

	polynomial: (t: number, noise: number): number =>
		(t * 2 - 1) ** 3 * 50 + noise * 5,

	randomWalk: (
		_t: number,
		noise: number,
		state: Float32Array,
		li: number,
	): number => {
		state[li] += noise * 2;
		return state[li];
	},

	step: (t: number, noise: number): number =>
		Math.floor(t * 5) * 2 + noise * 0.3,

	sigmoid: (t: number, noise: number): number =>
		1 / (1 + Math.exp(-(t - 0.5) * 10)) + noise * 0.05,

	tanh: (t: number, noise: number): number =>
		Math.tanh((t - 0.5) * 6) + noise * 0.1,

	dampedSine: (t: number, noise: number): number =>
		Math.exp(-t * 2) *
		Math.sin(t * Math.PI * 8) *
		(0.9 + Math.abs(noise) * 0.2),

	sawtooth: (t: number, noise: number): number =>
		((t * 4) % 1) * 2 - 1 + noise * 0.1,

	// Pre-computed: 2 * sigma^2 = 2 * 0.15^2 = 0.045
	gaussian: (t: number, noise: number): number => {
		const d = t - 0.5;
		return Math.exp(-(d * d) / 0.045) + noise * 0.05;
	},

	logistic: (t: number, noise: number): number =>
		(1 / (1 + Math.exp(-10 * (t - 0.5)))) * (0.95 + Math.abs(noise) * 0.1),
};

// Default curve if type not found
const defaultCurve = curveFunctions.sin as CurveFunction;

// ============================================================================
// Per-line variation parameters
// ============================================================================

interface LineParams {
	ampMul: number;
	freqMul: number;
	phaseAdd: number;
	offset: number;
}

/**
 * Compute variation parameters for all lines.
 */
function computeLineParams(lines: number, curveType: string): LineParams[] {
	const params: LineParams[] = new Array(lines);
	const denom = Math.max(1, lines - 1);

	// Separation factor varies by curve type
	const sep =
		curveType === "accuracy" || curveType === "loss"
			? 0.08
			: curveType === "randomWalk"
				? 2.5
				: 1.0;

	for (let li = 0; li < lines; li++) {
		const frac = li / denom;
		const phase = frac * Math.PI * 2;
		params[li] = {
			ampMul: 0.85 + frac * 0.3,
			freqMul: 0.9 + Math.sin(phase * 0.7) * 0.12,
			phaseAdd: phase * 0.15,
			offset: (frac - 0.5) * sep * 10,
		};
	}
	return params;
}

// ============================================================================
// Main generation logic
// ============================================================================

interface GeneratedData {
	x: Float32Array | Float64Array;
	ys: (Float32Array | Float64Array)[];
	yMin: number;
	yMax: number;
}

/**
 * Generate curve data for all points and lines.
 */
function generateData(
	points: number,
	lines: number,
	curveType: string,
	dataFormat: DataFormat = "float32",
): GeneratedData {
	// Select array type based on format
	const ArrayType = dataFormat === "float64" ? Float64Array : Float32Array;

	// Allocate output arrays
	const x = new ArrayType(points);
	const ys: (Float32Array | Float64Array)[] = new Array(lines);
	for (let li = 0; li < lines; li++) {
		ys[li] = new ArrayType(points);
	}

	// Pre-compute per-line parameters (hoisted out of hot loop)
	const lineParams = computeLineParams(lines, curveType);

	// Select curve function once (avoids switch per iteration)
	const curveFn = curveFunctions[curveType] || defaultCurve;
	const isRandomWalk = curveType === "randomWalk";

	// Random walk state (shared across points, separate per line)
	const walkState = isRandomWalk ? new Float32Array(lines) : null;

	// Track y bounds (x bounds are trivially [0, points-1])
	let yMin = Infinity;
	let yMax = -Infinity;

	const xMaxIdx = points - 1;

	// Main generation loop
	for (let i = 0; i < points; i++) {
		x[i] = i;
		const t = i / xMaxIdx;

		for (let li = 0; li < lines; li++) {
			const p = lineParams[li];
			const tLine = t * p.freqMul + p.phaseAdd;
			const noise = randomCentered();

			// Compute curve value - randomWalk needs extra args
			const raw = isRandomWalk
				? (curveFn as RandomWalkFunction)(tLine, noise, walkState!, li)
				: (curveFn as CurveFunction)(tLine, noise);

			// Apply per-line amplitude and offset
			const v = raw * p.ampMul + p.offset;
			ys[li][i] = v;

			// Update bounds
			if (v < yMin) yMin = v;
			if (v > yMax) yMax = v;
		}
	}

	return { x, ys, yMin, yMax };
}

// ============================================================================
// Message handler
// ============================================================================

self.onmessage = function (e: MessageEvent<WorkerRequest>): void {
	const {
		requestId,
		numPoints,
		numLines = 1,
		curveType = "sin",
		dataFormat = "float32",
	} = e.data;

	try {
		// Validate and clamp inputs (bitwise OR for fast floor)
		const points = Math.max(10, Math.min(MAX_POINTS, numPoints | 0));
		const lines = Math.max(1, Math.min(MAX_LINES, numLines | 0));

		// Memory safety check (Float64Array = 8 bytes per element, Float32Array = 4)
		const bytesPerElement = dataFormat === "float64" ? 8 : 4;
		const estBytes = (1 + lines) * points * bytesPerElement;
		if (estBytes > MAX_BYTES) {
			const estMB = (estBytes / (1024 * 1024)).toFixed(1);
			const maxMB = (MAX_BYTES / (1024 * 1024)).toFixed(0);
			throw new Error(
				`Data too large: ${estMB}MB for ${lines} lines × ${points} points (max ${maxMB}MB)`,
			);
		}

		// Seed RNG with timestamp + requestId to ensure unique data each time
		// Previously used requestId alone which could produce similar data
		const seed = (requestId * 2654435761 + Date.now()) | 0;
		seedRng(seed || 1);
		
		console.log(`[Worker] Generating: requestId=${requestId}, seed=${seed}, points=${points}, lines=${lines}, curve=${curveType}`);

		// Generate the data
		const { x, ys, yMin, yMax } = generateData(
			points,
			lines,
			curveType,
			dataFormat,
		);

		if (dataFormat === "json") {
			// Convert to JSON format: array of {x, y0, y1, ...} objects
			const jsonData: Record<string, number>[] = new Array(points);
			for (let i = 0; i < points; i++) {
				const point: Record<string, number> = { x: x[i] };
				for (let li = 0; li < lines; li++) {
					point[`y${li}`] = ys[li][i];
				}
				jsonData[i] = point;
			}

			// Post JSON as string (no transferable buffers)
			const response: WorkerResponse = {
				requestId,
				success: true,
				x: null,
				ys: JSON.stringify(jsonData),
				length: points,
				numLines: lines,
				curveType,
				dataFormat,
				xMin: 0,
				xMax: points - 1,
				yMin,
				yMax,
			};
			self.postMessage(response);
		} else {
			// float32 or float64: use transferable buffers
			const yBuffers = ys.map((arr) => arr.buffer);

			const response: WorkerResponse = {
				requestId,
				success: true,
				x: x.buffer,
				ys: yBuffers,
				length: points,
				numLines: lines,
				curveType,
				dataFormat,
				xMin: 0,
				xMax: points - 1,
				yMin,
				yMax,
			};
			self.postMessage(response, [x.buffer, ...yBuffers]);
		}
	} catch (error) {
		const response: WorkerResponse = {
			requestId,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
		self.postMessage(response);
	}
};
