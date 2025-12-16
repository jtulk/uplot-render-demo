# uPlot Performance Demo

A stress-testing demo showcasing [uPlot](https://github.com/leeoniya/uPlot)'s ability to render massive datasets with smooth performance, powered by a Web Worker pool architecture.

![uPlot Grid Demo](https://via.placeholder.com/800x400?text=16+Charts+×+Millions+of+Points)

## What This Demonstrates

- **Massive Dataset Rendering**: Render up to 10 million data points per chart across 16 simultaneous charts
- **Worker Pool Architecture**: Offload heavy data generation to background threads, keeping the UI responsive
- **TypedArray Transfers**: Efficient memory handling using `Float64Array` and transferable objects
- **Real-time Performance Metrics**: See generation time vs. render time for each chart

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## Features

### Configurable Parameters
- **Number of Points**: 10 → 10,000,000 points per chart
- **Number of Lines**: 1 → 1,000 series per chart

### 16 Curve Types
Each chart displays a different mathematical curve:
- Loss (exponential decay)
- Sine / Cosine waves
- Accuracy (learning curve)
- Linear / Exponential / Logarithmic
- Polynomial (cubic)
- Random Walk
- Step function
- Sigmoid / Tanh
- Damped Sine
- Sawtooth
- Gaussian
- Logistic growth

### Performance Metrics
Each chart displays:
- **Total time**: End-to-end generation + render
- **Gen time**: Data generation in worker
- **Render time**: uPlot canvas rendering

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Main Thread                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │   React     │───▶│ WorkerPool  │───▶│   uPlot     │ │
│  │   App.jsx   │    │  Manager    │    │  Instances  │ │
│  └─────────────┘    └──────┬──────┘    └─────────────┘ │
└────────────────────────────┼────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   Worker 1    │    │   Worker 2    │    │   Worker N    │
│ Float64Array  │    │ Float64Array  │    │ Float64Array  │
│  Generation   │    │  Generation   │    │  Generation   │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Worker Pool Features
- **Lazy spawning**: Workers created on-demand up to `navigator.hardwareConcurrency`
- **Idle cleanup**: Unused workers terminated after 30 seconds
- **Request queuing**: Overflow requests queued when all workers busy
- **Error recovery**: Crashed workers automatically replaced

## Why uPlot?

uPlot is a fast (~45KB min), memory-efficient time-series chart library that:
- Handles millions of points without downsampling
- Uses Canvas 2D for hardware-accelerated rendering
- Provides smooth pan/zoom interactions
- Has minimal dependencies

This demo proves uPlot can handle extreme data volumes while maintaining responsive UI through proper worker parallelization.

## Tech Stack

- **React 19** - UI framework
- **Vite 7** - Build tool
- **uPlot 1.6** - Charting library
- **Web Workers** - Background processing

## License

MIT
