# uPlot Performance Demo: Architecture Deep Dive

A comprehensive technical guide to understanding high-performance data visualization in JavaScript using Web Workers, TypedArrays, and transferable objects.

---

## Table of Contents

1. [The Problem: JavaScript's Single-Threaded Nature](#the-problem-javascripts-single-threaded-nature)
2. [The Solution: Worker Pool Architecture](#the-solution-worker-pool-architecture)
3. [Understanding JavaScript Memory](#understanding-javascript-memory)
4. [TypedArrays: The Foundation of Performance](#typedarrays-the-foundation-of-performance)
5. [Web Workers: Breaking Free from the Main Thread](#web-workers-breaking-free-from-the-main-thread)
6. [Transferable Objects: Zero-Copy Data Passing](#transferable-objects-zero-copy-data-passing)
7. [System Architecture](#system-architecture)
8. [Data Flow Diagrams](#data-flow-diagrams)
9. [Implementation Deep Dive](#implementation-deep-dive)
10. [Pros and Cons Analysis](#pros-and-cons-analysis)
11. [Performance Characteristics](#performance-characteristics)
12. [Key Takeaways](#key-takeaways)

---

## The Problem: JavaScript's Single-Threaded Nature

### Why This Demo Exists

Imagine you need to render 20 charts, each displaying 500 data series with 1 million points each. That's:

```
20 charts × 500 lines × 1,000,000 points = 10 BILLION data points
```

In traditional JavaScript, generating this data would look like:

```javascript
// ❌ This blocks the main thread for SECONDS
for (let i = 0; i < 1000000; i++) {
  for (let line = 0; line < 500; line++) {
    data[line][i] = Math.sin(i * 0.001) + Math.random() * 0.1;
  }
}
```

**The problem**: JavaScript runs on a single thread. While this loop executes:
- The UI freezes completely
- Users can't scroll, click, or interact
- The browser may show "Page Unresponsive" warnings
- Animations stutter or stop entirely

### The Event Loop Bottleneck

```
┌─────────────────────────────────────────────────────────────────┐
│                    JavaScript Event Loop                         │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │  Call Stack  │───▶│  Task Queue  │───▶│   Render     │───▶ ↺ │
│  │              │    │              │    │              │       │
│  │ ⚠️ BLOCKED   │    │ clicks       │    │ paint        │       │
│  │ by heavy    │    │ events       │    │ layout       │       │
│  │ computation │    │ callbacks    │    │ composite    │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│                                                                  │
│  If the Call Stack is busy, NOTHING ELSE runs!                  │
└─────────────────────────────────────────────────────────────────┘
```

When heavy computation occupies the call stack:
1. **Input events queue up** - clicks and keypresses wait
2. **Rendering is skipped** - the browser can't paint frames
3. **Perceived latency skyrockets** - users think the app is broken

---

## The Solution: Worker Pool Architecture

This demo solves the blocking problem through a **parallel worker pool architecture**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              MAIN THREAD                                    │
│                                                                             │
│  ┌─────────────────┐         ┌─────────────────┐        ┌───────────────┐  │
│  │                 │         │                 │        │               │  │
│  │   React App    │────────▶│   WorkerPool    │───────▶│    uPlot      │  │
│  │   (UI Logic)   │         │   (Scheduler)   │        │   (Render)    │  │
│  │                 │         │                 │        │               │  │
│  └─────────────────┘         └────────┬────────┘        └───────────────┘  │
│                                       │                                     │
│         UI stays responsive! ✓        │          Canvas rendering ✓         │
│                                       │                                     │
└───────────────────────────────────────┼─────────────────────────────────────┘
                                        │
           ┌────────────────────────────┼────────────────────────────┐
           │              WORKER THREADS (Parallel)                   │
           │                            │                             │
           │    postMessage()          │          postMessage()      │
           │    + transfer             ▼          + transfer         │
           │                                                          │
           │  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐    │
           │  │  Worker 1   │   │  Worker 2   │   │  Worker N   │    │
           │  │             │   │             │   │             │    │
           │  │ Float32     │   │ Float32     │   │ Float32     │    │
           │  │ Array       │   │ Array       │   │ Array       │    │
           │  │ Generation  │   │ Generation  │   │ Generation  │    │
           │  │             │   │             │   │             │    │
           │  └─────────────┘   └─────────────┘   └─────────────┘    │
           │                                                          │
           │    Heavy math runs here - main thread never blocked!     │
           └──────────────────────────────────────────────────────────┘
```

### Key Insight

The expensive work (generating millions of data points) happens in **parallel background threads**, while the main thread remains free to:
- Handle user interactions
- Render UI updates
- Keep animations smooth at 60fps

---

## Understanding JavaScript Memory

Before diving into TypedArrays, let's understand how JavaScript manages memory.

### Regular JavaScript Arrays

```javascript
const regularArray = [1.5, 2.7, 3.14159, 4.0, 5.123456789];
```

**Memory Layout of Regular Arrays:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Regular JavaScript Array                         │
│                                                                      │
│  Array Object (on Heap)                                             │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  length: 5                                                    │  │
│  │  [[Prototype]]: Array.prototype                               │  │
│  │                                                               │  │
│  │  Elements (may be sparse, non-contiguous):                    │  │
│  │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                     │  │
│  │  │ ptr │ │ ptr │ │ ptr │ │ ptr │ │ ptr │                     │  │
│  │  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘                     │  │
│  └─────┼───────┼───────┼───────┼───────┼────────────────────────┘  │
│        │       │       │       │       │                            │
│        ▼       ▼       ▼       ▼       ▼                            │
│  ┌─────────┬─────────┬─────────┬─────────┬─────────┐               │
│  │ Number  │ Number  │ Number  │ Number  │ Number  │               │
│  │ Object  │ Object  │ Object  │ Object  │ Object  │               │
│  │ (64-bit │ (64-bit │ (64-bit │ (64-bit │ (64-bit │               │
│  │ float)  │ float)  │ float)  │ float)  │ float)  │               │
│  │ + meta  │ + meta  │ + meta  │ + meta  │ + meta  │               │
│  └─────────┴─────────┴─────────┴─────────┴─────────┘               │
│                                                                      │
│  Total: ~24+ bytes per element (pointer + object overhead)          │
└─────────────────────────────────────────────────────────────────────┘
```

**Problems with Regular Arrays for Numerical Data:**

| Issue | Impact |
|-------|--------|
| **Boxing overhead** | Each number is wrapped in an object with type info |
| **Pointer indirection** | CPU must follow pointers to reach actual values |
| **Memory fragmentation** | Values scattered across the heap |
| **Cache unfriendly** | Poor CPU cache utilization |
| **GC pressure** | Millions of small objects = expensive garbage collection |

### The Cost at Scale

```javascript
// 1 million numbers in a regular array
const million = new Array(1_000_000).fill(0).map(() => Math.random());

// Memory usage: ~24MB+ (24 bytes × 1,000,000)
// GC overhead: Must track 1,000,000 individual objects
```

---

## TypedArrays: The Foundation of Performance

TypedArrays provide **contiguous, fixed-type memory** - exactly like arrays in C or Rust.

### TypedArray Memory Layout

```javascript
const float32Array = new Float32Array([1.5, 2.7, 3.14159, 4.0, 5.123456789]);
```

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Float32Array                                  │
│                                                                      │
│  TypedArray Object (minimal overhead)                               │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  length: 5                                                    │  │
│  │  byteLength: 20                                               │  │
│  │  byteOffset: 0                                                │  │
│  │  buffer: ArrayBuffer ──────────────────────────┐              │  │
│  └────────────────────────────────────────────────┼──────────────┘  │
│                                                   │                  │
│                                                   ▼                  │
│  ArrayBuffer (contiguous memory block)                              │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                                                               │  │
│  │  Byte 0    Byte 4    Byte 8    Byte 12   Byte 16             │  │
│  │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐            │  │
│  │  │ 1.5  │  │ 2.7  │  │3.1416│  │ 4.0  │  │5.1235│            │  │
│  │  │      │  │      │  │      │  │      │  │      │            │  │
│  │  │4 byte│  │4 byte│  │4 byte│  │4 byte│  │4 byte│            │  │
│  │  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘            │  │
│  │                                                               │  │
│  │  Raw binary data - NO object wrappers, NO pointers!          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Total: Exactly 20 bytes (4 bytes × 5 elements)                     │
└─────────────────────────────────────────────────────────────────────┘
```

### TypedArray Types and Use Cases

| Type | Bytes | Range | Use Case |
|------|-------|-------|----------|
| `Int8Array` | 1 | -128 to 127 | Audio samples, pixel data |
| `Uint8Array` | 1 | 0 to 255 | Image data, binary protocols |
| `Int16Array` | 2 | -32,768 to 32,767 | Audio, sensor data |
| `Uint16Array` | 2 | 0 to 65,535 | Image depth maps |
| `Int32Array` | 4 | -2B to 2B | Large integers |
| `Uint32Array` | 4 | 0 to 4B | Counts, indices |
| **`Float32Array`** | 4 | ±3.4×10³⁸ | **Charts, 3D graphics, ML** |
| `Float64Array` | 8 | ±1.7×10³⁰⁸ | Scientific computing |
| `BigInt64Array` | 8 | ±9×10¹⁸ | Cryptography, timestamps |

### Memory Comparison at Scale

```
┌─────────────────────────────────────────────────────────────────────┐
│              Memory Usage: 1 Million Numbers                         │
│                                                                      │
│  Regular Array (Number objects):                                    │
│  ████████████████████████████████████████████████  ~24 MB           │
│  (24 bytes × 1,000,000 + array overhead)                            │
│                                                                      │
│  Float64Array:                                                       │
│  ████████  8 MB                                                      │
│  (8 bytes × 1,000,000, exact)                                       │
│                                                                      │
│  Float32Array:                                                       │
│  ████  4 MB                                                          │
│  (4 bytes × 1,000,000, exact)                                       │
│                                                                      │
│  Savings: 83-96% memory reduction!                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Why Float32 vs Float64?

This demo supports both formats. Here's when to use each:

**Float32Array (default in this demo):**
```javascript
// 32-bit floating point: ~7 decimal digits precision
const float32 = new Float32Array([3.141592653589793]);
console.log(float32[0]); // 3.1415927410125732 (precision loss!)
```
- ✅ Half the memory of Float64
- ✅ Faster to generate and transfer
- ✅ Sufficient for visualization (pixel precision is ~1/1000)
- ❌ Loses precision beyond 7 significant digits

**Float64Array:**
```javascript
// 64-bit floating point: ~15 decimal digits precision
const float64 = new Float64Array([3.141592653589793]);
console.log(float64[0]); // 3.141592653589793 (full precision)
```
- ✅ Full JavaScript number precision
- ✅ Required for scientific calculations
- ❌ Double the memory usage
- ❌ Slower to transfer

### The ArrayBuffer: Underlying Raw Memory

Every TypedArray is a **view** into an `ArrayBuffer`:

```javascript
// Create raw memory (16 bytes)
const buffer = new ArrayBuffer(16);

// Multiple views into the SAME memory:
const asFloat32 = new Float32Array(buffer);   // 4 elements
const asFloat64 = new Float64Array(buffer);   // 2 elements
const asUint8 = new Uint8Array(buffer);       // 16 elements

// They all share the same underlying bytes!
asFloat32[0] = 1.5;
console.log(asUint8.slice(0, 4)); // Uint8Array [0, 0, 192, 63]
// ^ That's the IEEE 754 binary representation of 1.5!
```

```
┌─────────────────────────────────────────────────────────────────────┐
│                     ArrayBuffer (16 bytes)                           │
│  ┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬───┐  │
│  │ 00 │ 01 │ 02 │ 03 │ 04 │ 05 │ 06 │ 07 │ 08 │ 09 │ 10 │ 11 │...│  │
│  └────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴───┘  │
│                                                                      │
│  Float32Array view:  [ elem 0 ] [ elem 1 ] [ elem 2 ] [ elem 3 ]    │
│  Float64Array view:  [   element 0    ] [   element 1    ]          │
│  Uint8Array view:    [0][1][2][3][4][5][6][7][8][9]...              │
│                                                                      │
│  Same memory, different interpretations!                             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Web Workers: Breaking Free from the Main Thread

### What is a Web Worker?

A Web Worker runs JavaScript in a **separate OS thread**, completely isolated from the main thread:

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser Process                            │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                     Main Thread                              │ │
│  │  • DOM access ✓                                             │ │
│  │  • window object ✓                                          │ │
│  │  • React rendering ✓                                        │ │
│  │  • User event handling ✓                                    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                            ↕ postMessage()                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                     Worker Thread                            │ │
│  │  • NO DOM access ✗                                          │ │
│  │  • NO window object ✗                                       │ │
│  │  • Own global scope (self)                                  │ │
│  │  • CPU-intensive work ✓                                     │ │
│  │  • TypedArray generation ✓                                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   Another Worker Thread                      │ │
│  │  • Completely independent                                   │ │
│  │  • Can run in parallel with other workers                   │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Worker Communication: postMessage

Workers communicate via **message passing** - there's no shared memory by default:

```javascript
// main.js
const worker = new Worker('worker.js');

worker.postMessage({ numPoints: 1000000 });

worker.onmessage = (event) => {
  console.log('Received:', event.data);
};
```

```javascript
// worker.js
self.onmessage = (event) => {
  const { numPoints } = event.data;
  const result = new Float32Array(numPoints);
  // ... generate data ...
  self.postMessage(result);
};
```

### The Copy Problem

By default, `postMessage` **clones** data using the [Structured Clone Algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm):

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Default postMessage (COPY)                       │
│                                                                      │
│  Worker Thread                              Main Thread              │
│  ┌────────────────────┐                    ┌────────────────────┐   │
│  │  Float32Array      │                    │  Float32Array      │   │
│  │  ┌──────────────┐  │   COPY (slow!)    │  ┌──────────────┐  │   │
│  │  │ 4MB of data  │  │ ═══════════════▶  │  │ 4MB of data  │  │   │
│  │  │              │  │                    │  │  (clone)     │  │   │
│  │  └──────────────┘  │                    │  └──────────────┘  │   │
│  │                    │                    │                    │   │
│  │  ⚠️ Original       │                    │  ✓ Independent    │   │
│  │    still exists    │                    │    copy           │   │
│  └────────────────────┘                    └────────────────────┘   │
│                                                                      │
│  Memory: 8MB total (4MB × 2)                                        │
│  Time: O(n) - must copy every byte                                  │
└─────────────────────────────────────────────────────────────────────┘
```

For 1 million Float32 values (4MB), copying takes ~10-50ms. That's pure overhead!

---

## Transferable Objects: Zero-Copy Data Passing

### The Solution: Transfer Ownership

ArrayBuffers can be **transferred** instead of copied. The ownership moves from one context to another:

```javascript
// worker.js
const buffer = new Float32Array(1000000);
// ... fill with data ...

// Transfer ownership (zero-copy!)
self.postMessage(buffer, [buffer.buffer]);
//                        ^^^^^^^^^^^^^^
//                        List of buffers to transfer

// ⚠️ buffer is now NEUTERED (unusable) in this context!
console.log(buffer.byteLength); // 0
```

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Transferable postMessage (ZERO-COPY)               │
│                                                                      │
│  Worker Thread                              Main Thread              │
│  ┌────────────────────┐                    ┌────────────────────┐   │
│  │  Float32Array      │                    │                    │   │
│  │  ┌──────────────┐  │   TRANSFER        │                    │   │
│  │  │ 4MB of data  │══╪═══════════════════╪══▶ Float32Array    │   │
│  │  │              │  │   (move pointer)  │    ┌──────────────┐│   │
│  │  └──────────────┘  │                    │    │ 4MB of data ││   │
│  │         ↓          │                    │    │ (same bytes)││   │
│  │  ┌──────────────┐  │                    │    └──────────────┘│   │
│  │  │  NEUTERED    │  │                    │                    │   │
│  │  │ byteLength=0 │  │                    │                    │   │
│  │  └──────────────┘  │                    └────────────────────┘   │
│  └────────────────────┘                                             │
│                                                                      │
│  Memory: 4MB total (same memory, moved)                             │
│  Time: O(1) - just pointer reassignment!                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Transfer vs Copy Performance

```
┌─────────────────────────────────────────────────────────────────────┐
│           Transfer Time: 100MB Float32Array                          │
│                                                                      │
│  Structured Clone (copy):                                           │
│  ████████████████████████████████████████████████  ~200-500ms       │
│                                                                      │
│  Transferable (zero-copy):                                          │
│  █  <1ms                                                             │
│                                                                      │
│  Speedup: 200-500x faster!                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### Implementation in This Demo

From `pointGenerator.worker.js`:

```javascript
// Generate data in TypedArrays
const x = new Float32Array(points);
const ys = lines.map(() => new Float32Array(points));

// Fill with computed values...

// Transfer ALL buffers to main thread (zero-copy)
self.postMessage(
  {
    requestId,
    success: true,
    x: x.buffer,           // ArrayBuffer, not Float32Array
    ys: ys.map(y => y.buffer),
    // ... metadata
  },
  [x.buffer, ...ys.map(y => y.buffer)]  // Transferable list
);

// After this line, x and ys are NEUTERED (unusable) in the worker
```

From `workerPool.js` (receiving side):

```javascript
worker.onmessage = (event) => {
  const { x, ys, dataFormat } = event.data;
  
  // Reconstruct TypedArray views from transferred buffers
  const xArray = new Float32Array(x);    // x is an ArrayBuffer
  const yArrays = ys.map(b => new Float32Array(b));
  
  // Now xArray and yArrays are usable on the main thread!
};
```

---

## System Architecture

### Component Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              APPLICATION LAYER                              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                           App.jsx                                    │   │
│  │                                                                      │   │
│  │  • React state management (numPoints, numLines, numPanels)          │   │
│  │  • Debounced input handling                                         │   │
│  │  • WorkerPool lifecycle management                                  │   │
│  │  • uPlot instance creation and updates                              │   │
│  │  • Performance metrics collection                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                     │                                       │
│                                     │ generateData()                        │
│                                     ▼                                       │
├────────────────────────────────────────────────────────────────────────────┤
│                             SCHEDULING LAYER                                │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        WorkerPool.js                                 │   │
│  │                                                                      │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────────┐│   │
│  │  │   Worker    │  │   Request   │  │        Lifecycle             ││   │
│  │  │  Registry   │  │    Queue    │  │        Manager               ││   │
│  │  │             │  │             │  │                              ││   │
│  │  │ • active    │  │ • FIFO      │  │ • lazy spawn                 ││   │
│  │  │ • idle      │  │ • pending   │  │ • idle cleanup (30s)         ││   │
│  │  │ • lastUsed  │  │ • timeouts  │  │ • error recovery             ││   │
│  │  └─────────────┘  └─────────────┘  └──────────────────────────────┘│   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                     │                                       │
│                          postMessage + transfer                             │
│                                     ▼                                       │
├────────────────────────────────────────────────────────────────────────────┤
│                            COMPUTATION LAYER                                │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   Worker 1   │  │   Worker 2   │  │   Worker 3   │  │   Worker N   │   │
│  │              │  │              │  │              │  │              │   │
│  │ pointGen     │  │ pointGen     │  │ pointGen     │  │ pointGen     │   │
│  │ erator.      │  │ erator.      │  │ erator.      │  │ erator.      │   │
│  │ worker.js    │  │ worker.js    │  │ worker.js    │  │ worker.js    │   │
│  │              │  │              │  │              │  │              │   │
│  │ • xorshift   │  │ • xorshift   │  │ • xorshift   │  │ • xorshift   │   │
│  │   PRNG       │  │   PRNG       │  │   PRNG       │  │   PRNG       │   │
│  │ • curve fn   │  │ • curve fn   │  │ • curve fn   │  │ • curve fn   │   │
│  │ • TypedArray │  │ • TypedArray │  │ • TypedArray │  │ • TypedArray │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                                             │
│  Max workers: navigator.hardwareConcurrency (typically 4-16)               │
└────────────────────────────────────────────────────────────────────────────┘
```

### WorkerPool State Machine

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        WorkerPool State Machine                              │
│                                                                              │
│                           ┌───────────────┐                                  │
│                           │   CREATED     │                                  │
│                           │  (no workers) │                                  │
│                           └───────┬───────┘                                  │
│                                   │ initialize()                             │
│                                   ▼                                          │
│                           ┌───────────────┐                                  │
│                           │  INITIALIZED  │                                  │
│                           │ (min workers) │                                  │
│                           └───────┬───────┘                                  │
│                                   │                                          │
│              ┌────────────────────┴────────────────────┐                    │
│              ▼                                         ▼                    │
│      ┌───────────────┐                         ┌───────────────┐            │
│      │ generatePoints│                         │ idle timeout  │            │
│      │   (request)   │                         │  (cleanup)    │            │
│      └───────┬───────┘                         └───────┬───────┘            │
│              │                                         │                    │
│      ┌───────┴───────┐                         ┌───────┴───────┐            │
│      ▼               ▼                         ▼               ▼            │
│  ┌────────┐    ┌──────────┐              ┌──────────┐    ┌──────────┐       │
│  │ Worker │    │ Workers  │              │ Remove   │    │ Keep min │       │
│  │ avail  │    │ at max   │              │ idle     │    │ workers  │       │
│  │        │    │ capacity │              │ worker   │    │          │       │
│  └───┬────┘    └────┬─────┘              └──────────┘    └──────────┘       │
│      │              │                                                        │
│      │         ┌────┴────┐                                                  │
│      │         ▼         ▼                                                  │
│      │    ┌────────┐ ┌────────┐                                             │
│      │    │ Spawn  │ │ Queue  │                                             │
│      │    │ worker │ │request │                                             │
│      │    └───┬────┘ └───┬────┘                                             │
│      │        │          │                                                  │
│      └────────┴──────────┘                                                  │
│              │                                                               │
│              ▼                                                               │
│      ┌───────────────┐         ┌───────────────┐                            │
│      │    ACTIVE     │────────▶│   COMPLETE    │                            │
│      │  processing   │ result  │   (resolve)   │                            │
│      └───────────────┘         └───────────────┘                            │
│              │                                                               │
│              │ error/timeout                                                 │
│              ▼                                                               │
│      ┌───────────────┐                                                       │
│      │    ERROR      │                                                       │
│      │  (reject +    │                                                       │
│      │   replace)    │                                                       │
│      └───────────────┘                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagrams

### Complete Request Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Data Generation Request Lifecycle                         │
│                                                                              │
│  Time ──────────────────────────────────────────────────────────────────▶   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ MAIN THREAD                                                          │    │
│  │                                                                      │    │
│  │  [1] User adjusts    [2] Debounced     [3] React calls              │    │
│  │      slider              state              generateData()          │    │
│  │      │                   update             │                       │    │
│  │      ▼                   │                  ▼                       │    │
│  │  ┌────────┐              │             ┌──────────┐                 │    │
│  │  │ Input  │──400ms──────▶├────────────▶│ Worker   │                 │    │
│  │  │ Event  │   debounce   │             │ Pool     │                 │    │
│  │  └────────┘              │             └────┬─────┘                 │    │
│  │                                             │                       │    │
│  └─────────────────────────────────────────────┼───────────────────────┘    │
│                                                │                             │
│                                      postMessage({ numPoints,               │
│                                        numLines, curveType })               │
│                                                │                             │
│  ┌─────────────────────────────────────────────┼───────────────────────┐    │
│  │ WORKER THREAD                               ▼                        │    │
│  │                                                                      │    │
│  │  [4] Receive        [5] Allocate        [6] Generate                │    │
│  │      message            TypedArrays         curve data              │    │
│  │      │                  │                   │                       │    │
│  │      ▼                  ▼                   ▼                       │    │
│  │  ┌────────┐        ┌──────────┐        ┌──────────┐                 │    │
│  │  │ Parse  │───────▶│ new      │───────▶│ for loop │                 │    │
│  │  │ config │        │Float32   │        │ compute  │                 │    │
│  │  └────────┘        │Array(n)  │        │ values   │                 │    │
│  │                    └──────────┘        └────┬─────┘                 │    │
│  │                                             │                       │    │
│  │                         [7] Transfer buffers (zero-copy)            │    │
│  │                                             │                       │    │
│  └─────────────────────────────────────────────┼───────────────────────┘    │
│                                                │                             │
│                                      postMessage(buffers,                   │
│                                        [transferList])                      │
│                                                │                             │
│  ┌─────────────────────────────────────────────┼───────────────────────┐    │
│  │ MAIN THREAD                                 ▼                        │    │
│  │                                                                      │    │
│  │  [8] Receive        [9] Wrap in        [10] Update                  │    │
│  │      buffers            TypedArray          uPlot                   │    │
│  │      │                  views               │                       │    │
│  │      ▼                  │                   ▼                       │    │
│  │  ┌──────────┐      ┌──────────┐        ┌──────────┐                 │    │
│  │  │ onmess   │─────▶│ new      │───────▶│ plot.    │                 │    │
│  │  │ age      │      │Float32   │        │ setData()│                 │    │
│  │  │ handler  │      │Array(buf)│        │          │                 │    │
│  │  └──────────┘      └──────────┘        └──────────┘                 │    │
│  │                                                                      │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Parallel Generation (Multiple Panels)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              Parallel Data Generation for 8 Panels (4 Workers)              │
│                                                                              │
│  Time ──────────────────────────────────────────────────────────────────▶   │
│                                                                              │
│  Main Thread:                                                                │
│  ──────────────────────────────────────────────────────────────────────     │
│  │ dispatch │                                              │ render all │   │
│  │ 8 reqs   │                                              │ 8 panels   │   │
│  ────────────                                              ──────────────   │
│       │                                                         ▲           │
│       │ req 1-8                                          results│           │
│       ▼                                                         │           │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         WorkerPool Queue                              │  │
│  │                                                                       │  │
│  │  Initially: [req1, req2, req3, req4, req5, req6, req7, req8]        │  │
│  │                                                                       │  │
│  │  After dispatch: [req5, req6, req7, req8] (waiting)                  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│       │ immediate        │ immediate       │ immediate       │ immediate   │
│       ▼                  ▼                 ▼                 ▼             │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐      ┌──────────┐       │
│  │ Worker 1 │      │ Worker 2 │      │ Worker 3 │      │ Worker 4 │       │
│  │          │      │          │      │          │      │          │       │
│  │ ████████ │ req1 │ ████████ │ req2 │ ████████ │ req3 │ ████████ │ req4  │
│  │ ████████ │ req5 │ ████████ │ req6 │ ████████ │ req7 │ ████████ │ req8  │
│  │          │      │          │      │          │      │          │       │
│  └──────────┘      └──────────┘      └──────────┘      └──────────┘       │
│       │                  │                 │                 │             │
│       ▼                  ▼                 ▼                 ▼             │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                        Results (in completion order)                 │  │
│  │                                                                      │  │
│  │  result1 ──┬──▶ result3 ──┬──▶ result2 ──┬──▶ result4 ──┬──▶ ...   │  │
│  │            │              │              │              │            │  │
│  │   uPlot    │    uPlot     │    uPlot     │    uPlot     │            │  │
│  │   panel 1  │    panel 3   │    panel 2   │    panel 4   │            │  │
│  │   renders  │    renders   │    renders   │    renders   │            │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Note: Results arrive in parallel as workers complete, not in order!        │
│        UI updates progressively - panels appear as their data is ready.     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Memory Transfer Detail

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Memory Ownership During Transfer                           │
│                                                                              │
│  BEFORE postMessage (data owned by worker):                                 │
│  ─────────────────────────────────────────                                  │
│                                                                              │
│  Worker Memory Space                    Main Thread Memory Space            │
│  ┌────────────────────────┐            ┌────────────────────────┐           │
│  │                        │            │                        │           │
│  │  ┌──────────────────┐  │            │                        │           │
│  │  │  ArrayBuffer     │  │            │                        │           │
│  │  │  ┌────────────┐  │  │            │                        │           │
│  │  │  │ 4MB data   │  │  │            │       (empty)          │           │
│  │  │  │ ■■■■■■■■■  │  │  │            │                        │           │
│  │  │  └────────────┘  │  │            │                        │           │
│  │  │  byteLength: 4MB │  │            │                        │           │
│  │  └──────────────────┘  │            │                        │           │
│  │                        │            │                        │           │
│  └────────────────────────┘            └────────────────────────┘           │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                              │
│  AFTER postMessage with transfer (ownership moved):                         │
│  ──────────────────────────────────────────────────                         │
│                                                                              │
│  Worker Memory Space                    Main Thread Memory Space            │
│  ┌────────────────────────┐            ┌────────────────────────┐           │
│  │                        │            │                        │           │
│  │  ┌──────────────────┐  │            │  ┌──────────────────┐  │           │
│  │  │  ArrayBuffer     │  │            │  │  ArrayBuffer     │  │           │
│  │  │  ┌────────────┐  │  │            │  │  ┌────────────┐  │  │           │
│  │  │  │ NEUTERED!  │  │  │ ────────▶  │  │  │ 4MB data   │  │  │           │
│  │  │  │ (empty)    │  │  │  (moved)   │  │  │ ■■■■■■■■■  │  │  │           │
│  │  │  └────────────┘  │  │            │  │  └────────────┘  │  │           │
│  │  │  byteLength: 0   │  │            │  │  byteLength: 4MB │  │           │
│  │  └──────────────────┘  │            │  └──────────────────┘  │           │
│  │                        │            │                        │           │
│  └────────────────────────┘            └────────────────────────┘           │
│                                                                              │
│  Key insight: The actual bytes never moved! Only ownership/access changed.  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Deep Dive

### Point Generator Worker (`pointGenerator.worker.js`)

#### Fast PRNG (Pseudo-Random Number Generator)

```javascript
// Standard Math.random() is cryptographically secure but slow.
// xorshift32 is deterministic and ~2-3x faster.

let rngState = 1;

function seedRng(seed) {
  rngState = seed | 0 || 1;  // Ensure non-zero integer
}

function random() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 4294967296;  // [0, 1)
}
```

**Why xorshift?**
- Deterministic: same seed = same sequence (great for debugging)
- Fast: just bit operations, no system calls
- Good enough: passes basic randomness tests for visualization

#### Curve Functions (Hot Path Optimization)

```javascript
const curveFunctions = {
  loss: (t, noise) => Math.exp(-t * 3) * (0.85 + noise * 0.3),
  sin: (t, noise) => Math.sin(t * Math.PI * 4) * (0.85 + noise * 0.3),
  // ... 14 more curve types
};

// Select function ONCE before the loop (avoids switch per iteration)
const curveFn = curveFunctions[curveType] || defaultCurve;
```

**Performance insight**: Function lookup happens once, not millions of times.

#### Main Generation Loop

```javascript
function generateData(points, lines, curveType, dataFormat = "float32") {
  // Choose array type based on format
  const ArrayType = dataFormat === "float64" ? Float64Array : Float32Array;

  // Pre-allocate all memory upfront
  const x = new ArrayType(points);
  const ys = new Array(lines);
  for (let li = 0; li < lines; li++) {
    ys[li] = new ArrayType(points);
  }

  // Pre-compute per-line parameters (hoisted out of hot loop)
  const lineParams = computeLineParams(lines, curveType);

  // Main loop - optimized for CPU cache
  for (let i = 0; i < points; i++) {
    x[i] = i;
    const t = i / (points - 1);

    for (let li = 0; li < lines; li++) {
      const p = lineParams[li];
      const noise = randomCentered();
      const v = curveFn(t * p.freqMul + p.phaseAdd, noise) * p.ampMul + p.offset;
      ys[li][i] = v;
    }
  }

  return { x, ys, yMin, yMax };
}
```

**Optimizations:**
1. Pre-allocation: No array resizing during computation
2. Hoisted lookups: `lineParams` computed once
3. Sequential access: Iterates through memory in order (cache-friendly)
4. Minimal branching: Direct function call, no conditionals in loop

### Worker Pool (`workerPool.js`)

#### Lazy Spawning Strategy

```javascript
async generatePoints(numPoints, numLines, curveType, dataFormat) {
  // Look for an idle worker first
  let worker = this.workers.find(w => !this.activeWorkers.has(w));

  // Only spawn new worker if:
  // 1. No idle workers available AND
  // 2. We haven't reached maxPoolSize
  if (!worker && this.workers.length < this.maxPoolSize) {
    worker = this.createWorker();  // Spawn on-demand
  }

  if (worker) {
    // Dispatch immediately
    this.activeWorkers.add(worker);
    worker.postMessage({ ... });
  } else {
    // Queue for later (all workers busy)
    this.queue.push({ ... });
  }
}
```

**Benefits:**
- No upfront cost: Workers spawn only when needed
- Memory efficient: Idle workers are cleaned up
- Responsive: First request doesn't wait for pool initialization

#### Idle Cleanup

```javascript
cleanupIdleWorkers() {
  const now = Date.now();

  for (const worker of this.workers) {
    // Skip active workers
    if (this.activeWorkers.has(worker)) continue;
    
    // Keep minimum workers warm
    if (this.workers.length <= this.minWorkers) break;

    // Terminate if idle too long
    const lastUsed = this.workerLastUsed.get(worker);
    if (now - lastUsed > 30000) {  // 30 seconds
      this.removeWorker(worker);
    }
  }
}
```

**Why cleanup?**
- Each worker thread consumes ~2-10MB memory
- Idle workers waste resources
- Keeping 1 worker warm avoids cold-start latency

#### Request Timeout Handling

```javascript
const timeoutId = setTimeout(() => {
  if (!this.pendingRequests.has(requestId)) return;
  
  this.pendingRequests.delete(requestId);
  reject(new Error("Worker request timed out"));
  
  // Terminate problematic worker
  this.removeWorker(worker);
  
  // Replace if needed
  if (this.workers.length < this.minWorkers) {
    this.createWorker();
  }
}, 20000);  // 20 second timeout
```

**Why timeouts?**
- Prevents UI from hanging forever if a worker crashes
- Automatically recovers by spawning replacement workers
- Gives user feedback instead of silent failure

---

## Pros and Cons Analysis

### Advantages ✅

| Aspect | Benefit |
|--------|---------|
| **UI Responsiveness** | Main thread never blocks, even with millions of points |
| **Memory Efficiency** | TypedArrays use 83-96% less memory than regular arrays |
| **Transfer Speed** | Zero-copy transfers complete in <1ms regardless of data size |
| **Parallel Scaling** | Utilizes multiple CPU cores effectively |
| **Progressive Loading** | Results appear as they complete, not all-at-once |
| **Error Isolation** | Worker crashes don't affect main thread |
| **Clean Architecture** | Clear separation between UI and computation |

### Trade-offs ⚠️

| Aspect | Consideration |
|--------|---------------|
| **Complexity** | More code than synchronous approach |
| **Debugging** | Worker errors harder to trace (separate context) |
| **Initialization Cost** | First worker spawn takes ~10-50ms |
| **Communication Overhead** | postMessage has ~0.1-1ms latency per call |
| **No Shared Memory** | Each worker has isolated memory (by design) |
| **Browser Support** | Module workers need modern browsers |
| **Build Setup** | Requires bundler configuration (Vite handles this) |

### When to Use This Pattern

**✅ Use workers + TypedArrays when:**
- Processing > 10,000 data points
- Computation takes > 16ms (one frame)
- You need to keep UI responsive
- Memory usage is a concern
- Data can be represented as fixed-type numbers

**❌ Don't use when:**
- Simple computations (< 5ms)
- Data is small (< 1000 items)
- You need shared mutable state
- Data contains mixed types/objects
- Targeting very old browsers

---

## Performance Characteristics

### Measured Results (M1 MacBook Pro)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              Performance: 1M points × 10 lines (Float32)                    │
│                                                                              │
│  Single Worker:                                                              │
│  ├─ Data generation: ~45ms                                                  │
│  ├─ Transfer time: <1ms                                                     │
│  └─ uPlot render: ~8ms                                                      │
│                                                                              │
│  4 Workers (parallel, 4 panels):                                            │
│  ├─ Total wall time: ~55ms (vs ~200ms sequential)                          │
│  └─ Speedup: ~3.6x                                                          │
│                                                                              │
│  Memory per panel:                                                           │
│  ├─ Float32: (1 + 10) × 1M × 4 bytes = 44 MB                               │
│  └─ Float64: (1 + 10) × 1M × 8 bytes = 88 MB                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Scaling Behavior

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Generation Time vs Points                             │
│                                                                              │
│  Time (ms)                                                                   │
│  │                                                                           │
│  │                                                       ╱                  │
│  │                                                     ╱                    │
│  │                                                   ╱  1M points           │
│  │                                                 ╱    ~45ms               │
│  │                                               ╱                          │
│  │                                         ╱───╱                            │
│  │                                   ╱────╱                                 │
│  │                            ╱─────╱                                       │
│  │                      ╱────╱  100K points                                 │
│  │               ╱─────╱        ~5ms                                        │
│  │        ╱─────╱                                                           │
│  │  ╱────╱  10K points: ~0.5ms                                              │
│  └──────────────────────────────────────────────────────────── Points       │
│       10K      100K      500K      1M        5M       10M                   │
│                                                                              │
│  Complexity: O(points × lines) - linear scaling                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Takeaways

### For the JavaScript Developer

1. **The main thread is precious** - Any computation > 16ms risks dropping frames. Offload to workers.

2. **TypedArrays are your friend** - For numerical data, they offer:
   - Predictable memory layout
   - Dramatically reduced memory usage
   - Faster iteration (no object overhead)
   - Transferable between threads

3. **Transfers beat copies** - Always use the transferable objects API when sending ArrayBuffers:
   ```javascript
   worker.postMessage(data, [data.buffer]);  // ✅ Zero-copy
   worker.postMessage(data);                  // ❌ Full clone
   ```

4. **Worker pools beat single workers** - Manage complexity, enable parallelism, handle failures gracefully.

5. **Lazy initialization wins** - Don't spawn workers until needed, don't keep them alive when idle.

### Mental Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     The Performance Pyramid                                  │
│                                                                              │
│                           ╱╲                                                 │
│                          ╱  ╲                                                │
│                         ╱ UI ╲  ← Must be responsive (< 16ms)               │
│                        ╱──────╲                                              │
│                       ╱        ╲                                             │
│                      ╱ TRANSFER ╲  ← Zero-copy when possible                │
│                     ╱────────────╲                                           │
│                    ╱              ╲                                          │
│                   ╱   GENERATION   ╲  ← Offload to workers                  │
│                  ╱──────────────────╲                                        │
│                 ╱                    ╲                                       │
│                ╱     TYPED ARRAYS     ╲  ← Foundation of efficiency         │
│               ╱────────────────────────╲                                     │
│                                                                              │
│  Build on TypedArrays, offload generation, transfer efficiently, keep UI   │
│  responsive. Each layer depends on the ones below it.                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Further Reading

- [MDN: Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [MDN: Transferable Objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
- [MDN: TypedArray](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypedArray)
- [Chrome DevTools: Performance Analysis](https://developer.chrome.com/docs/devtools/performance/)
- [uPlot GitHub](https://github.com/leeoniya/uPlot)

---

*This architecture document accompanies the uPlot Performance Demo. Run `npm run dev` to see these concepts in action.*

