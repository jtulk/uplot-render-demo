import React, { useEffect, useRef, useState, useCallback } from "react";
import uPlot from "uplot";
import type {
	ProfilerStats,
	RenderStats,
	DataFormat,
	CurveType,
	LineStyle,
	DataBounds,
	PlotDomains,
	GenerateResult,
} from "../types";
import type WorkerPool from "../workers/workerPool";

// ============================================================================
// Utility Functions
// ============================================================================

function formatBytes(bytes: number | null | undefined): string | null {
	if (bytes == null) return null;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface FormattedStats {
	total: string;
	generateMs: number | null;
	drawMs: number | null;
	reactMs: number | null;
	memory: string | null;
}

function formatStats(
	stats: RenderStats | number | null | undefined,
	profilerStats: ProfilerStats | undefined,
): FormattedStats | null {
	if (!stats) return null;

	if (typeof stats === "object") {
		const { totalMs, generateMs, drawMs, memoryBytes } = stats;
		if (typeof totalMs === "number") {
			return {
				total: `${totalMs}ms`,
				generateMs: generateMs ?? null,
				drawMs: drawMs ?? null,
				reactMs: profilerStats?.actualDuration ?? null,
				memory: formatBytes(memoryBytes),
			};
		}
	}

	if (typeof stats === "number") {
		return {
			total: `${stats}ms`,
			generateMs: null,
			drawMs: null,
			reactMs: null,
			memory: null,
		};
	}

	return null;
}

function calculateDataMemory(
	data: (Float32Array | Float64Array | number[])[],
): number {
	if (!data || !Array.isArray(data)) return 0;

	return data.reduce((total, arr) => {
		if (arr && "byteLength" in arr && arr.byteLength !== undefined) {
			return total + arr.byteLength;
		} else if (Array.isArray(arr)) {
			return total + arr.length * 8 + 24;
		}
		return total;
	}, 0);
}

function getDomainsFromBounds(
	bounds: DataBounds | null,
	numPoints: number,
): PlotDomains {
	if (!bounds) {
		return { x: [0, numPoints - 1], y: [-100, 100] };
	}

	const { xMin, xMax, yMin, yMax } = bounds;
	const xRange = xMax - xMin || 1;
	const yRange = yMax - yMin || 1;

	const xPadding = xRange * 0.03;
	const yPadding = yRange * 0.1;

	return {
		x: [xMin - xPadding, xMax + xPadding],
		y: [yMin - yPadding, yMax + yPadding],
	};
}

function getContainerDimensions(container: HTMLElement): {
	width: number;
	height: number;
} {
	const width = container.offsetWidth || 300;
	const isMobile = window.innerWidth <= 599;
	const isLarge = window.innerWidth >= 1400;
	const aspectRatio = isMobile ? 4 / 3 : isLarge ? 2 / 1 : 16 / 9;
	const height = Math.round(width / aspectRatio);
	return { width, height };
}

function createPlotOptions(
	width: number,
	height: number,
	domains: PlotDomains,
	lineStyles: LineStyle[],
): uPlot.Options {
	return {
		title: "",
		width,
		height,
		scales: {
			x: { time: false, min: domains.x[0], max: domains.x[1] },
			y: { time: false, min: domains.y[0], max: domains.y[1] },
		},
		series: [{}, ...lineStyles],
		axes: [
			{
				show: true,
				stroke: "rgba(107,114,128,0.9)",
				grid: { stroke: "rgba(229,231,235,0.9)" },
			},
			{
				show: true,
				stroke: "rgba(107,114,128,0.9)",
				grid: { stroke: "rgba(229,231,235,0.9)" },
			},
		],
		cursor: { show: false },
		legend: { show: false },
	};
}

// ============================================================================
// Component Props
// ============================================================================

export interface PlotPanelProps {
	index: number;
	title: string;
	curveType: CurveType;
	numPoints: number;
	numLines: number;
	dataFormat: DataFormat;
	lineStyles: LineStyle[];
	workerPool: WorkerPool | null;
	regenerateToken: number; // Increment to trigger regeneration
	onStatusChange?: (
		index: number,
		status: "loading" | "generating" | "idle",
	) => void;
	profilerStats?: ProfilerStats;
}

// ============================================================================
// PlotPanel Component - Smart component that owns its data lifecycle
// ============================================================================

export default function PlotPanel({
	index,
	title,
	curveType,
	numPoints,
	numLines,
	dataFormat,
	lineStyles,
	workerPool,
	regenerateToken,
	onStatusChange,
	profilerStats,
}: PlotPanelProps): React.ReactElement {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const plotRef = useRef<uPlot | null>(null);
	const isMountedRef = useRef(true);
	const runTokenRef = useRef(0);
	const lastRegenerateTokenRef = useRef(-1);
	const isRegeneratingRef = useRef(false);

	const [isLoading, setIsLoading] = useState(true);
	const [isGenerating, setIsGenerating] = useState(false);
	const [stats, setStats] = useState<RenderStats | null>(null);

	// Report status changes to parent
	const reportStatus = useCallback(
		(status: "loading" | "generating" | "idle") => {
			onStatusChange?.(index, status);
		},
		[index, onStatusChange],
	);

	// Core regeneration logic
	const doRegenerate = useCallback(async () => {
		if (!workerPool || !containerRef.current) return;

		// Prevent concurrent regenerations for this panel
		if (isRegeneratingRef.current) return;
		isRegeneratingRef.current = true;

		const startTime = performance.now();
		runTokenRef.current += 1;
		const thisToken = runTokenRef.current;

		setIsGenerating(true);
		reportStatus("generating");

		try {
			// Request data from worker pool
			const result: GenerateResult = await workerPool.generatePoints(
				numPoints,
				numLines,
				curveType,
				dataFormat,
			);

			// Check if this request is still relevant
			if (!isMountedRef.current || runTokenRef.current !== thisToken) {
				isRegeneratingRef.current = false;
				return;
			}

			const genEndTime = performance.now();
			const generateMs = Math.round(genEndTime - startTime);

			const { data, bounds } = result;
			const container = containerRef.current;
			if (!container) {
				isRegeneratingRef.current = false;
				return;
			}

			const domains = getDomainsFromBounds(bounds, numPoints);
			const memoryBytes = calculateDataMemory(data);
			const drawStart = performance.now();

			if (plotRef.current) {
				// Update existing plot
				plotRef.current.batch(() => {
					plotRef.current!.setData(data as uPlot.AlignedData);

					for (let li = 0; li < numLines; li++) {
						const s = lineStyles[li];
						plotRef.current!.setSeries(li + 1, {
							stroke: s.stroke,
							width: s.width,
							dash: s.dash,
						} as uPlot.Series);
					}

					plotRef.current!.setScale("x", {
						min: domains.x[0],
						max: domains.x[1],
					});
					plotRef.current!.setScale("y", {
						min: domains.y[0],
						max: domains.y[1],
					});
				});
			} else {
				// Create new plot
				const { width, height } = getContainerDimensions(container);
				const opts = createPlotOptions(width, height, domains, lineStyles);
				plotRef.current = new uPlot(opts, data as uPlot.AlignedData, container);
			}

			const drawEnd = performance.now();
			const drawMs = Math.round(drawEnd - drawStart);
			const totalMs = Math.round(drawEnd - startTime);

			// Log data fingerprint to verify regeneration produces new data
			const firstY = data[1]?.[0] ?? 0;
			const lastY = data[1]?.[data[1]?.length - 1] ?? 0;
			console.log(
				`[Panel ${index}] Data fingerprint: first=${firstY.toFixed(4)}, last=${lastY.toFixed(4)}, points=${data[0]?.length}`,
			);
			console.log(
				`[Panel ${index}] Total: ${totalMs}ms (gen: ${generateMs}ms + draw: ${drawMs}ms)`,
			);

			setStats({
				totalMs,
				generateMs,
				drawMs,
				memoryBytes,
			});

			setIsLoading(false);
			setIsGenerating(false);
			reportStatus("idle");
			isRegeneratingRef.current = false;
		} catch (error) {
			console.error(`Panel ${index} error:`, error);
			if (isMountedRef.current) {
				setIsGenerating(false);
				setIsLoading(false);
				reportStatus("idle");
			}
			isRegeneratingRef.current = false;
		}
	}, [
		workerPool,
		numPoints,
		numLines,
		curveType,
		dataFormat,
		lineStyles,
		index,
		reportStatus,
	]);

	// Keep a stable ref to the latest doRegenerate
	const doRegenerateRef = useRef(doRegenerate);
	useEffect(() => {
		doRegenerateRef.current = doRegenerate;
	}, [doRegenerate]);

	// Respond to regenerateToken changes (from "Regenerate All" or param changes)
	useEffect(() => {
		if (regenerateToken !== lastRegenerateTokenRef.current) {
			console.log(
				`[Panel ${index}] Regenerate triggered: token ${lastRegenerateTokenRef.current} -> ${regenerateToken}`,
			);
			lastRegenerateTokenRef.current = regenerateToken;
			// Use setTimeout(0) to ensure React has finished its render cycle
			// This allows multiple panels to queue their requests independently
			setTimeout(() => {
				doRegenerateRef.current();
			}, 0);
		}
	}, [regenerateToken, index]);

	// Initial mount and cleanup
	useEffect(() => {
		isMountedRef.current = true;
		reportStatus("loading");

		return () => {
			isMountedRef.current = false;
			runTokenRef.current += 1;
			if (plotRef.current) {
				plotRef.current.destroy();
				plotRef.current = null;
			}
		};
	}, [reportStatus]);

	// Handle window resize
	useEffect(() => {
		let resizeTimer: ReturnType<typeof setTimeout>;

		const handleResize = () => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				if (plotRef.current && containerRef.current) {
					const { width, height } = getContainerDimensions(
						containerRef.current,
					);
					if (width > 0 && height > 0) {
						plotRef.current.setSize({ width, height });
					}
				}
			}, 150);
		};

		window.addEventListener("resize", handleResize);
		return () => {
			clearTimeout(resizeTimer);
			window.removeEventListener("resize", handleResize);
		};
	}, []);

	// Manual regenerate button handler
	const handleManualRegenerate = useCallback(() => {
		doRegenerateRef.current();
	}, []);

	const formatted = formatStats(stats, profilerStats);

	return (
		<section className="plot-card" aria-label={`${title} plot`}>
			<header className="plot-card__header">
				<div className="plot-card__header-spacer" />
				<div className="plot-card__title">{title}</div>
				<div className="plot-card__actions">
					<button
						className="plot-card__regen"
						onClick={handleManualRegenerate}
						disabled={isGenerating || isLoading}
						type="button"
					>
						{isGenerating || isLoading ? "Generating…" : "Regenerate"}
					</button>
				</div>
			</header>

			<div className="plot-card__body">
				<div ref={containerRef} className="plot-canvas">
					{isLoading && (
						<div className="plot-loading">
							<div className="plot-loading-spinner" />
							<div className="plot-loading-text">Generating…</div>
						</div>
					)}
				</div>
			</div>

			<footer className="plot-card__footer">
				<div className="plot-card__stats">
					{formatted ? (
						<>
							<div className="plot-card__stat-total">{formatted.total}</div>
							<div className="plot-card__stat-breakdown">
								{formatted.generateMs != null && (
									<span className="plot-card__stat-chip plot-card__stat-chip--gen">
										gen {formatted.generateMs}ms
									</span>
								)}
								{formatted.drawMs != null && (
									<span className="plot-card__stat-chip plot-card__stat-chip--draw">
										draw {formatted.drawMs}ms
									</span>
								)}
								{formatted.reactMs != null && (
									<span className="plot-card__stat-chip plot-card__stat-chip--react">
										react {formatted.reactMs}ms
									</span>
								)}
							</div>
							{formatted.memory && (
								<span className="plot-card__stat-chip plot-card__stat-chip--memory">
									{formatted.memory}
								</span>
							)}
						</>
					) : (
						<div className="plot-card__stat-placeholder">—</div>
					)}
				</div>
			</footer>
		</section>
	);
}
