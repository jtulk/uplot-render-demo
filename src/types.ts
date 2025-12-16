// ============================================================================
// Shared Types for uPlot Performance Demo
// ============================================================================

// Data formats supported by the worker
export type DataFormat = "float32" | "float64" | "json";

// Curve types available for generation
export type CurveType =
	| "loss"
	| "sin"
	| "accuracy"
	| "linear"
	| "exponential"
	| "logarithmic"
	| "cosine"
	| "polynomial"
	| "randomWalk"
	| "step"
	| "sigmoid"
	| "tanh"
	| "dampedSine"
	| "sawtooth"
	| "gaussian"
	| "logistic";

// Bounds returned by the worker
export interface DataBounds {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
}

// Domain ranges for plot scales
export interface PlotDomains {
	x: [number, number];
	y: [number, number];
}

// Result from worker pool generatePoints
export interface GenerateResult {
	data: (Float32Array | Float64Array | number[])[];
	bounds: DataBounds;
}

// Render timing stats for a plot
export interface RenderStats {
	totalMs: number;
	generateMs: number;
	drawMs: number;
	paintMs?: number;
	memoryBytes: number;
}

// Profiler data from React.Profiler
export interface ProfilerStats {
	actualDuration: number;
	baseDuration: number;
	phase: string;
}

// Pool statistics
export interface PoolStats {
	maxPoolSize: number;
	currentWorkers: number;
	activeWorkers: number;
	idleWorkers: number;
	queueLength: number;
	pendingRequests: number;
}

// Worker snapshot info
export interface WorkerInfo {
	index: number;
	active: boolean;
	requestId: number | null;
	lastUsedMsAgo: number | null;
}

// Full pool snapshot
export interface PoolSnapshot {
	maxPoolSize: number;
	minWorkers: number;
	currentWorkers: number;
	activeWorkers: number;
	idleWorkers: number;
	queueLength: number;
	pendingRequests: number;
	workers: WorkerInfo[];
}

// Line style for uPlot series
export interface LineStyle {
	stroke: string;
	width: number;
	dash: number[];
}

// ============================================================================
// Worker Message Types
// ============================================================================

// Message sent TO the worker
export interface WorkerRequest {
	requestId: number;
	numPoints: number;
	numLines: number;
	curveType: CurveType | string;
	dataFormat: DataFormat;
}

// Success message FROM the worker
export interface WorkerSuccessResponse {
	requestId: number;
	success: true;
	x: ArrayBuffer | null;
	ys: ArrayBuffer[] | string;
	length: number;
	numLines: number;
	curveType: string;
	dataFormat: DataFormat;
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
}

// Error message FROM the worker
export interface WorkerErrorResponse {
	requestId: number;
	success: false;
	error: string;
}

export type WorkerResponse = WorkerSuccessResponse | WorkerErrorResponse;

// ============================================================================
// Worker Pool Internal Types
// ============================================================================

export interface PendingRequest {
	resolve: (result: GenerateResult) => void;
	reject: (error: Error) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

export interface QueuedRequest {
	numPoints: number;
	numLines: number;
	curveType: string;
	dataFormat: DataFormat;
	requestId: number;
	resolve: (result: GenerateResult) => void;
	reject: (error: Error) => void;
}
