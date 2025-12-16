import React, {
	useEffect,
	useRef,
	useState,
	useCallback,
	useMemo,
	Profiler,
	type ProfilerOnRenderCallback,
	type ChangeEvent,
} from "react";
import "uplot/dist/uPlot.min.css";
import "./App.css";
import WorkerPool from "./workers/workerPool";
import PointGeneratorWorker from "./workers/pointGenerator.worker.ts?worker";
import PlotPanel from "./components/PlotPanel";
import type {
	CurveType,
	DataFormat,
	ProfilerStats,
	PoolStats,
	PoolSnapshot,
	LineStyle,
} from "./types";

// Logarithmic point values for the slider
const POINT_VALUES = [10, 100, 1000, 10000, 100000, 1000000] as const;

// 16 unique curve types
const CURVE_TYPES: CurveType[] = [
	"loss",
	"sin",
	"accuracy",
	"linear",
	"exponential",
	"logarithmic",
	"cosine",
	"polynomial",
	"randomWalk",
	"step",
	"sigmoid",
	"tanh",
	"dampedSine",
	"sawtooth",
	"gaussian",
	"logistic",
];

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
	const [debouncedValue, setDebouncedValue] = useState<T>(value);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedValue(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);

	return debouncedValue;
}

function hexToRgba(hex: string, alpha: number): string {
	const h = hex.replace("#", "").trim();
	const full =
		h.length === 3
			? h
					.split("")
					.map((c) => c + c)
					.join("")
			: h;
	const r = parseInt(full.slice(0, 2), 16);
	const g = parseInt(full.slice(2, 4), 16);
	const b = parseInt(full.slice(4, 6), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Calmer W&B-ish palette (avoid rainbow banding at high line counts)
function generateWandbLineStyles(count: number): LineStyle[] {
	const palette = [
		"#2B6FF7", // wandb-ish blue
		"#FF7A00", // wandb-ish orange
		"#7C3AED", // purple
		"#10B981", // green
		"#06B6D4", // cyan
		"#EF4444", // red
		"#F59E0B", // amber
		"#111827", // near-black
		"#F472B6", // pink
		"#22D3EE", // light blue
		"#A3E635", // neon green
		"#FBBF24", // gold
		"#FDE68A", // light yellow
		"#3B82F6", // azure
		"#9CA3AF", // gray
		"#F87171", // salmon
		"#4ADE80", // mint green
		"#8B5CF6", // violet
	];

	const alpha =
		count >= 300 ? 0.03 : count >= 120 ? 0.045 : count >= 40 ? 0.07 : 0.18;
	const width = count >= 120 ? 1 : 1.5;

	return Array.from({ length: count }, (_, i) => {
		const base = palette[i % palette.length];
		const a = Math.max(0.02, Math.min(0.22, alpha + (i % 7) * 0.002));
		return {
			stroke: hexToRgba(base, a),
			width,
			dash: [],
		};
	});
}

// Get helpful hint message for worker errors
function getWorkerErrorHint(
	isFileProtocol: boolean = window.location?.protocol === "file:",
): string {
	return isFileProtocol
		? "You're opening via file://. Module workers won't load. Use `npm run dev` or serve `dist/` over http."
		: "Check the browser console for worker load/parse errors.";
}

// Pool Stats Component
interface PoolStatsProps {
	stats: PoolStats | null;
}

function PoolStatsComponent({ stats }: PoolStatsProps): React.ReactNode {
	if (!stats) return null;

	const { maxPoolSize, currentWorkers, activeWorkers, queueLength } = stats;

	return (
		<div className="pool-stats">
			<div className="pool-stat">
				<span className="pool-stat-label">Workers:</span>
				<div className="worker-dots">
					{Array.from({ length: maxPoolSize }, (_, i) => (
						<div
							key={i}
							className={`worker-dot ${
								i < activeWorkers ? "active" : i < currentWorkers ? "idle" : ""
							}`}
						/>
					))}
				</div>
				<span className="pool-stat-value">
					{activeWorkers}/{currentWorkers}
				</span>
			</div>
			<div className="pool-stat">
				<span className="pool-stat-label">Queue:</span>
				<span className="pool-stat-value">{queueLength}</span>
			</div>
		</div>
	);
}

function App(): React.ReactElement {
	const workerPoolRef = useRef<WorkerPool | null>(null);

	// Hardware limit for workers
	const hardwareLimit = navigator.hardwareConcurrency || 4;

	// Input state (immediate) vs actual state (debounced)
	const [inputPointsIndex, setInputPointsIndex] = useState(3);
	const [inputNumLines, setInputNumLines] = useState(50);
	const [inputMaxWorkers, setInputMaxWorkers] = useState(1);
	const [inputNumPanels, setInputNumPanels] = useState(25);
	const [dataFormat, setDataFormat] = useState<DataFormat>("float32");

	const debouncedPointsIndex = useDebounce(inputPointsIndex, 400);
	const numPoints = POINT_VALUES[debouncedPointsIndex];
	const numLines = useDebounce(inputNumLines, 400);
	const maxWorkers = useDebounce(inputMaxWorkers, 400);
	const numPanels = useDebounce(inputNumPanels, 400);

	// Regenerate token - increment to signal all panels to regenerate
	// Starts at 1 so panels regenerate on mount
	const [regenerateToken, setRegenerateToken] = useState(1);

	// Track panel statuses for UI feedback
	const [panelStatuses, setPanelStatuses] = useState<Map<number, string>>(
		new Map(),
	);
	const profilerDataRef = useRef<Record<number, ProfilerStats>>({});

	const [poolStats, setPoolStats] = useState<PoolStats | null>(null);
	const [poolError, setPoolError] = useState<string | null>(null);
	const [poolSnapshot, setPoolSnapshot] = useState<PoolSnapshot | null>(null);
	const initialMaxWorkersRef = useRef(maxWorkers);
	const isMountedRef = useRef(false);

	// Count busy panels
	const busyPanelCount = useMemo(() => {
		let count = 0;
		panelStatuses.forEach((status) => {
			if (status === "loading" || status === "generating") {
				count++;
			}
		});
		return count;
	}, [panelStatuses]);

	const isAnyGenerating = busyPanelCount > 0;

	// Update pool stats periodically (only if changed)
	useEffect(() => {
		const interval = setInterval(() => {
			if (workerPoolRef.current) {
				const newStats = workerPoolRef.current.getStats();
				const newSnapshot = workerPoolRef.current.getSnapshot();

				setPoolStats((prev) => {
					if (
						prev &&
						prev.maxPoolSize === newStats.maxPoolSize &&
						prev.currentWorkers === newStats.currentWorkers &&
						prev.activeWorkers === newStats.activeWorkers &&
						prev.queueLength === newStats.queueLength
					) {
						return prev;
					}
					return newStats;
				});

				setPoolSnapshot((prev) => {
					if (
						prev &&
						prev.activeWorkers === newSnapshot.activeWorkers &&
						prev.idleWorkers === newSnapshot.idleWorkers &&
						prev.queueLength === newSnapshot.queueLength &&
						prev.pendingRequests === newSnapshot.pendingRequests &&
						prev.workers.length === newSnapshot.workers.length &&
						prev.workers.every(
							(w, i) =>
								w.active === newSnapshot.workers[i]?.active &&
								w.requestId === newSnapshot.workers[i]?.requestId,
						)
					) {
						return prev;
					}
					return newSnapshot;
				});
			}
		}, 500);
		return () => clearInterval(interval);
	}, []);

	// Initialize worker pool
	useEffect(() => {
		isMountedRef.current = true;
		workerPoolRef.current = new WorkerPool(
			PointGeneratorWorker,
			initialMaxWorkersRef.current,
		);
		setPoolError(null);

		// Worker self-test
		const testWorker = new PointGeneratorWorker();
		let didFinish = false;
		const timeoutId = setTimeout(() => {
			if (didFinish) return;
			didFinish = true;
			try {
				testWorker.terminate();
			} catch {
				// ignore
			}
			if (!isMountedRef.current) return;
			setPoolError(`Worker self-test timed out. ${getWorkerErrorHint()}`);
		}, 2000);

		testWorker.onmessage = (e: MessageEvent) => {
			if (didFinish) return;
			didFinish = true;
			clearTimeout(timeoutId);
			try {
				testWorker.terminate();
			} catch {
				// ignore
			}
			const { success, error } = e.data || {};
			if (!success) {
				console.error("Worker self-test failed:", error);
				if (!isMountedRef.current) return;
				setPoolError(
					`Worker self-test failed: ${
						error || "unknown error"
					}. ${getWorkerErrorHint()}`,
				);
			}
		};

		testWorker.onerror = (err: ErrorEvent) => {
			if (didFinish) return;
			didFinish = true;
			clearTimeout(timeoutId);
			try {
				testWorker.terminate();
			} catch {
				// ignore
			}
			console.error("Worker self-test error:", err);
			if (!isMountedRef.current) return;
			setPoolError(`Worker self-test errored. ${getWorkerErrorHint()}`);
		};

		testWorker.postMessage({
			requestId: 0,
			numPoints: 64,
			numLines: 1,
			curveType: "sin",
		});

		return () => {
			isMountedRef.current = false;
			clearTimeout(timeoutId);
			try {
				testWorker.terminate();
			} catch {
				// ignore
			}
			if (workerPoolRef.current) {
				workerPoolRef.current.terminate();
			}
		};
	}, []);

	// Apply max workers changes live
	useEffect(() => {
		if (!workerPoolRef.current) return;
		workerPoolRef.current.setMaxPoolSize(maxWorkers);
		setPoolStats(workerPoolRef.current.getStats());
		setPoolSnapshot(workerPoolRef.current.getSnapshot());
	}, [maxWorkers]);

	// When params change, trigger regeneration for all panels
	useEffect(() => {
		// Skip the initial mount (token starts at 1)
		setRegenerateToken((prev) => prev + 1);
	}, [numPoints, numLines, dataFormat]);

	// Generate series styles - memoized by numLines
	const lineStyles = useMemo(() => {
		return generateWandbLineStyles(numLines);
	}, [numLines]);

	// Handle regenerate all - just increment the token
	const handleRegenerateAll = useCallback(() => {
		setRegenerateToken((prev) => prev + 1);
	}, []);

	// Handle status change from individual panels
	const handlePanelStatusChange = useCallback(
		(index: number, status: "loading" | "generating" | "idle") => {
			setPanelStatuses((prev) => {
				const next = new Map(prev);
				next.set(index, status);
				return next;
			});
		},
		[],
	);

	// React Profiler callback
	const handleProfilerRender: ProfilerOnRenderCallback = useCallback(
		(id, phase, actualDuration, baseDuration) => {
			const index = parseInt(id.replace("plot-", ""), 10);
			if (!isNaN(index)) {
				profilerDataRef.current[index] = {
					actualDuration: Math.round(actualDuration * 100) / 100,
					baseDuration: Math.round(baseDuration * 100) / 100,
					phase,
				};
			}
		},
		[],
	);

	return (
		<div className="app-layout">
			{/* Left Sidebar - Controls */}
			<aside className="sidebar">
				<div className="sidebar__header">
					<h1>
						<span>uPlot</span> Performance Demo
					</h1>
				</div>

				<div className="sidebar__controls">
					<div className="control-group">
						<label htmlFor="dataFormat">Data Format</label>
						<select
							id="dataFormat"
							value={dataFormat}
							onChange={(e: ChangeEvent<HTMLSelectElement>) =>
								setDataFormat(e.target.value as DataFormat)
							}
							className="data-format-select"
						>
							<option value="float32">Float32</option>
							<option value="float64">Float64</option>
							<option value="json">JSON {"{x, y}"}</option>
						</select>
					</div>

					<div className="control-group">
						<label htmlFor="numWorkers">Workers</label>
						<div className="slider-row">
							<input
								id="numWorkers"
								type="range"
								min="1"
								max={hardwareLimit}
								value={inputMaxWorkers}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setInputMaxWorkers(parseInt(e.target.value))
								}
							/>
							<span className="slider-value">{inputMaxWorkers}</span>
						</div>
					</div>

					<div className="control-group">
						<label htmlFor="numPoints">Points</label>
						<div className="slider-row">
							<input
								id="numPoints"
								type="range"
								min="0"
								max={POINT_VALUES.length - 1}
								step="1"
								value={inputPointsIndex}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setInputPointsIndex(parseInt(e.target.value))
								}
							/>
							<span className="slider-value">
								{POINT_VALUES[inputPointsIndex].toLocaleString()}
							</span>
						</div>
					</div>

					<div className="control-group">
						<label htmlFor="numLines">Lines</label>
						<div className="slider-row">
							<input
								id="numLines"
								type="range"
								min="10"
								max="500"
								step="10"
								value={inputNumLines}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setInputNumLines(parseInt(e.target.value))
								}
							/>
							<span className="slider-value">{inputNumLines}</span>
						</div>
					</div>

					<div className="control-group">
						<label htmlFor="numPanels">Panels</label>
						<div className="slider-row">
							<input
								id="numPanels"
								type="range"
								min="1"
								max="100"
								value={inputNumPanels}
								onChange={(e: ChangeEvent<HTMLInputElement>) =>
									setInputNumPanels(parseInt(e.target.value))
								}
							/>
							<span className="slider-value">{inputNumPanels}</span>
						</div>
					</div>

					<button
						className="regenerate-all-btn"
						onClick={handleRegenerateAll}
						disabled={isAnyGenerating}
					>
						{isAnyGenerating
							? `Generating (${numPanels - busyPanelCount}/${numPanels})...`
							: "Regenerate All"}
					</button>
				</div>

				{poolError && (
					<div className="pool-error" role="alert">
						{poolError}
					</div>
				)}
			</aside>

			{/* Main Content - Plots Grid */}
			<main className="main-content">
				<div className="plots-grid">
					{Array.from({ length: numPanels }).map((_, index) => {
						const curveType = CURVE_TYPES[index % CURVE_TYPES.length];
						return (
							<Profiler
								key={index}
								id={`plot-${index}`}
								onRender={handleProfilerRender}
							>
								<PlotPanel
									index={index}
									title={curveType.charAt(0).toUpperCase() + curveType.slice(1)}
									curveType={curveType}
									numPoints={numPoints}
									numLines={numLines}
									dataFormat={dataFormat}
									lineStyles={lineStyles}
									workerPool={workerPoolRef.current}
									regenerateToken={regenerateToken}
									onStatusChange={handlePanelStatusChange}
									profilerStats={profilerDataRef.current[index]}
								/>
							</Profiler>
						);
					})}
				</div>
			</main>

			{/* Footer - Workers Status */}
			<footer className="app-footer">
				<div className="footer-workers">
					<div className="footer-workers__summary">
						<span className="footer-workers__title">Workers</span>
						{poolSnapshot ? (
							<>
								<span className="footer-stat">
									<span className="footer-stat__label">Active</span>
									<span className="footer-stat__value footer-stat__value--active">
										{poolSnapshot.activeWorkers}
									</span>
								</span>
								<span className="footer-stat">
									<span className="footer-stat__label">Idle</span>
									<span className="footer-stat__value footer-stat__value--idle">
										{poolSnapshot.idleWorkers}
									</span>
								</span>
								<span className="footer-stat">
									<span className="footer-stat__label">Queue</span>
									<span className="footer-stat__value">
										{poolSnapshot.queueLength}
									</span>
								</span>
								<span className="footer-stat">
									<span className="footer-stat__label">Pending</span>
									<span className="footer-stat__value">
										{poolSnapshot.pendingRequests}
									</span>
								</span>
							</>
						) : (
							<span className="footer-stat__value">—</span>
						)}
					</div>

					<div className="footer-workers__slots">
						{Array.from({ length: maxWorkers }).map((_, i) => {
							const w = poolSnapshot?.workers?.[i];
							const state = w ? (w.active ? "active" : "idle") : "unused";
							return (
								<div
									key={i}
									className={`footer-worker-dot footer-worker-dot--${state}`}
									title={
										w?.active
											? `W${i + 1}: req ${w.requestId ?? "—"}`
											: w
												? `W${i + 1}: idle`
												: `W${i + 1}: unused`
									}
								/>
							);
						})}
					</div>
				</div>

				<PoolStatsComponent stats={poolStats} />
			</footer>
		</div>
	);
}

export default App;
