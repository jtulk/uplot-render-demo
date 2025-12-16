// Worker Pool Manager with lazy spawning and idle cleanup

import type {
	DataFormat,
	GenerateResult,
	PendingRequest,
	PoolSnapshot,
	PoolStats,
	QueuedRequest,
	WorkerResponse,
	WorkerInfo,
} from "../types";

type WorkerConstructor = { new (): Worker } | string;

class WorkerPool {
	private workerConstructor: WorkerConstructor;
	private maxPoolSize: number;
	private workers: Worker[];
	private queue: QueuedRequest[];
	private activeWorkers: Set<Worker>;
	private requestIdCounter: number;
	private pendingRequests: Map<number, PendingRequest>;
	private workerToRequestId: Map<Worker, number>;
	private workerLastUsed: Map<Worker, number>;
	private requestTimeoutMs: number;
	private idleTimeout: number;
	private minWorkers: number;
	private cleanupInterval: ReturnType<typeof setInterval> | null;

	constructor(
		workerConstructor: WorkerConstructor,
		maxPoolSize: number = navigator.hardwareConcurrency || 4,
	) {
		this.workerConstructor = workerConstructor;
		this.maxPoolSize = Math.max(1, Math.floor(maxPoolSize || 1));
		this.workers = [];
		this.queue = [];
		this.activeWorkers = new Set();
		this.requestIdCounter = 0;
		this.pendingRequests = new Map();
		this.workerToRequestId = new Map();
		this.workerLastUsed = new Map();
		this.requestTimeoutMs = 20000; // reject stuck requests so UI can't hang forever

		// Idle cleanup settings
		this.idleTimeout = 30000; // 30 seconds
		this.minWorkers = 1; // Keep at least 1 warm worker
		this.cleanupInterval = null;

		// Start with minimum workers
		this.initialize();
		this.startIdleCleanup();
	}

	setMaxPoolSize(nextMaxPoolSize: number): void {
		const next = Math.max(1, Math.floor(nextMaxPoolSize || 1));
		this.maxPoolSize = next;

		// If we have more than max workers, remove idle ones first.
		// Never terminate active workers; they'll drain and can be cleaned up later.
		while (this.workers.length > this.maxPoolSize) {
			const idle = this.workers.find((w) => !this.activeWorkers.has(w));
			if (!idle) break;
			this.removeWorker(idle);
		}

		// Keep at least minWorkers if max allows it
		this.minWorkers = Math.min(this.minWorkers, this.maxPoolSize);
	}

	getSnapshot(): PoolSnapshot {
		const now = Date.now();
		const workers: WorkerInfo[] = this.workers.map((w, idx) => {
			const active = this.activeWorkers.has(w);
			const lastUsed = this.workerLastUsed.get(w) || 0;
			const requestId = this.workerToRequestId.get(w) ?? null;
			return {
				index: idx,
				active,
				requestId,
				lastUsedMsAgo: lastUsed ? now - lastUsed : null,
			};
		});

		return {
			maxPoolSize: this.maxPoolSize,
			minWorkers: this.minWorkers,
			currentWorkers: this.workers.length,
			activeWorkers: this.activeWorkers.size,
			idleWorkers: this.workers.length - this.activeWorkers.size,
			queueLength: this.queue.length,
			pendingRequests: this.pendingRequests.size,
			workers,
		};
	}

	private initialize(): void {
		// Start with just the minimum workers (lazy spawning)
		for (let i = 0; i < this.minWorkers; i++) {
			this.createWorker();
		}
	}

	private startIdleCleanup(): void {
		this.cleanupInterval = setInterval(() => {
			this.cleanupIdleWorkers();
		}, 10000); // Check every 10 seconds
	}

	private cleanupIdleWorkers(): void {
		const now = Date.now();
		const workersToRemove: Worker[] = [];

		for (const worker of this.workers) {
			// Don't remove active workers or if we're at minimum
			if (this.activeWorkers.has(worker)) continue;
			if (this.workers.length <= this.minWorkers) break;

			const lastUsed = this.workerLastUsed.get(worker) || 0;
			if (now - lastUsed > this.idleTimeout) {
				workersToRemove.push(worker);
			}
		}

		// Remove idle workers (keep at least minWorkers)
		for (const worker of workersToRemove) {
			if (this.workers.length <= this.minWorkers) break;
			this.removeWorker(worker);
		}
	}

	private removeWorker(worker: Worker): void {
		this.workers = this.workers.filter((w) => w !== worker);
		this.workerLastUsed.delete(worker);
		this.workerToRequestId.delete(worker);
		try {
			worker.terminate();
		} catch {
			// ignore
		}
	}

	private createWorker(): Worker | null {
		if (this.workers.length >= this.maxPoolSize) return null;

		const worker =
			typeof this.workerConstructor === "function"
				? new this.workerConstructor()
				: new Worker(this.workerConstructor, { type: "module" });

		worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
			const data = e.data;

			// Mark worker as recently used
			this.workerLastUsed.set(worker, Date.now());

			if (this.pendingRequests.has(data.requestId)) {
				const { resolve, reject, timeoutId } = this.pendingRequests.get(
					data.requestId,
				)!;
				this.pendingRequests.delete(data.requestId);
				this.activeWorkers.delete(worker);
				this.workerToRequestId.delete(worker);
				if (timeoutId) clearTimeout(timeoutId);

				if (data.success) {
					const { x, ys, xMin, xMax, yMin, yMax, dataFormat } = data;
					let resultData: (Float32Array | Float64Array | number[])[];

					if (dataFormat === "json") {
						// JSON format: convert array of {x, y0, y1, ...} objects to uPlot format
						const jsonData = JSON.parse(ys as string) as Record<
							string,
							number
						>[];
						const xArray = jsonData.map((pt) => pt.x);
						// Get all y keys (y0, y1, y2, ...) sorted numerically
						const yKeys = Object.keys(jsonData[0] || {})
							.filter((k) => k.startsWith("y"))
							.sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
						const yArrays = yKeys.map((k) => jsonData.map((pt) => pt[k]));
						resultData = [xArray, ...yArrays];
					} else if (dataFormat === "float64") {
						const xArray = new Float64Array(x as ArrayBuffer);
						const yArrays = Array.isArray(ys)
							? ys.map((b) => new Float64Array(b as ArrayBuffer))
							: [];
						resultData = [xArray, ...yArrays];
					} else {
						// float32 (default)
						const xArray = new Float32Array(x as ArrayBuffer);
						const yArrays = Array.isArray(ys)
							? ys.map((b) => new Float32Array(b as ArrayBuffer))
							: [];
						resultData = [xArray, ...yArrays];
					}

					resolve({
						data: resultData,
						bounds: { xMin, xMax, yMin, yMax },
					});
				} else {
					reject(new Error(data.error || "Worker error"));
				}
			}

			this.processQueue();
		};

		worker.onmessageerror = (error: MessageEvent) => {
			console.error("Worker message error:", error);
			// Treat as a worker failure so requests don't hang
			worker.onerror?.(error as unknown as ErrorEvent);
		};

		worker.onerror = (error: ErrorEvent) => {
			console.error("Worker error:", error);
			const requestId = this.workerToRequestId.get(worker);
			if (requestId != null && this.pendingRequests.has(requestId)) {
				const { reject, timeoutId } = this.pendingRequests.get(requestId)!;
				this.pendingRequests.delete(requestId);
				if (timeoutId) clearTimeout(timeoutId);
				reject(new Error("Worker crashed while processing request"));
			}

			this.activeWorkers.delete(worker);
			this.workerToRequestId.delete(worker);
			this.workerLastUsed.delete(worker);
			this.workers = this.workers.filter((w) => w !== worker);

			try {
				worker.terminate();
			} catch {
				// ignore
			}

			// Replace if we're below minimum
			if (this.workers.length < this.minWorkers) {
				this.createWorker();
			}

			this.processQueue();
		};

		this.workers.push(worker);
		this.workerLastUsed.set(worker, Date.now());
		return worker;
	}

	/**
	 * Dispatch a request to a specific worker
	 */
	private _dispatchToWorker(worker: Worker, request: QueuedRequest): void {
		const {
			numPoints,
			numLines,
			curveType,
			dataFormat,
			requestId,
			resolve,
			reject,
		} = request;

		this.activeWorkers.add(worker);
		this.workerToRequestId.set(worker, requestId);

		const timeoutId = setTimeout(() => {
			if (!this.pendingRequests.has(requestId)) return;
			this.pendingRequests.delete(requestId);
			this.activeWorkers.delete(worker);
			this.workerToRequestId.delete(worker);
			reject(new Error("Worker request timed out"));
			this.removeWorker(worker);
			if (this.workers.length < this.minWorkers) this.createWorker();
			this.processQueue();
		}, this.requestTimeoutMs);

		this.pendingRequests.set(requestId, { resolve, reject, timeoutId });

		worker.postMessage({
			requestId,
			numPoints,
			numLines,
			curveType,
			dataFormat,
		});
	}

	/**
	 * Get an available worker, spawning one if needed and capacity allows
	 */
	private _getAvailableWorker(): Worker | null {
		let worker = this.workers.find((w) => !this.activeWorkers.has(w));
		if (!worker && this.workers.length < this.maxPoolSize) {
			worker = this.createWorker() ?? undefined;
		}
		return worker ?? null;
	}

	private processQueue(): void {
		if (this.queue.length === 0) return;

		const worker = this._getAvailableWorker();
		if (worker) {
			const request = this.queue.shift()!;
			this._dispatchToWorker(worker, request);
		}
	}

	/**
	 * Request points generation from the worker pool
	 */
	async generatePoints(
		numPoints: number,
		numLines: number = 1,
		curveType: string = "sin",
		dataFormat: DataFormat = "float32",
	): Promise<GenerateResult> {
		const points = Math.max(10, Math.min(10000000, Math.floor(numPoints)));
		const lines = Math.max(1, Math.min(1000, Math.floor(numLines)));

		return new Promise<GenerateResult>((resolve, reject) => {
			const request: QueuedRequest = {
				numPoints: points,
				numLines: lines,
				curveType,
				dataFormat,
				requestId: ++this.requestIdCounter,
				resolve,
				reject,
			};

			const worker = this._getAvailableWorker();
			if (worker) {
				this._dispatchToWorker(worker, request);
			} else {
				// Queue item; timeout starts when actually assigned to a worker
				this.queue.push(request);
			}
		});
	}

	/**
	 * Terminate all workers and clean up
	 */
	terminate(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		this.queue.forEach(({ reject }) => {
			reject(new Error("Worker pool terminated"));
		});
		this.queue = [];
		this.workers.forEach((worker) => worker.terminate());
		this.workers = [];
		this.activeWorkers.clear();
		// Clear any pending timeouts
		for (const { timeoutId } of this.pendingRequests.values()) {
			if (timeoutId) clearTimeout(timeoutId);
		}
		this.pendingRequests.clear();
		this.workerToRequestId.clear();
		this.workerLastUsed.clear();
	}

	/**
	 * Get pool statistics
	 */
	getStats(): PoolStats {
		return {
			maxPoolSize: this.maxPoolSize,
			currentWorkers: this.workers.length,
			activeWorkers: this.activeWorkers.size,
			idleWorkers: this.workers.length - this.activeWorkers.size,
			queueLength: this.queue.length,
			pendingRequests: this.pendingRequests.size,
		};
	}
}

export default WorkerPool;
