# Commercial Leasing Contract Period Month Splitter

A deterministic financial slicing engine for commercial leasing contracts, designed to handle complex billing cycles, proration rules, and rate adjustments with mathematical consistency.

---

## Overview

This project provides a **contract period segmentation and billing engine** that transforms a leasing contract into a set of **financially consistent time segments**.

It is built to solve real-world complexities such as:

* Non-natural billing cycles (e.g. 14th → next 13th)
* Free rent periods
* Incremental rent adjustments (point-in-time or anniversary-based)
* Partial-period proration
* Cross-month accuracy correction
* Strict merging rules for financial integrity

---

## Core Capabilities

### 1. Time Segmentation (Cut-Based Model)

The engine splits a contract timeline into minimal segments based on:

* Contract boundaries
* Billing cycle anchors (pivot date)
* Free rent intervals
* Rate increase events

Each segment is **atomic and homogeneous** in financial logic.

---

### 2. Dual Weight System

Each segment carries a **time weight**:

#### • Bucket Weight (Primary)

Based on billing cycle:

```
weight = segment_days / bucket_days
```

Used for:

* Billing alignment
* Cycle normalization

---

#### • Natural Month Weight (Correction Layer)

Applied only to **fragmented segments**:

```
weight = Σ (days_in_month_segment / days_in_month)
```

Ensures:

* Accurate financial proration across calendar months
* Elimination of billing distortion

---

### 3. Rate Model

Supports compounded rate adjustments:

* **POINT**: applied at a specific date
* **ANNIVERSARY**: applied yearly after anchor date

Effective rate is:

```
R(t) = Π (1 + rate_k)
```

---

### 4. Free Rent Handling

Free rent is modeled as a **binary mask** over time:

* Rent = 0 during free periods
* Service fee remains chargeable

---

### 5. Segment Merging (Deterministic Compression)

Segments are merged only when:

* Same rate
* Same free rent status
* Not initial period
* Fully complete billing units (integer weight)

This guarantees:

* No financial distortion
* Reduced output complexity

---

### 6. Output Semantics

Each segment is classified as:

| Type        | monthEquivalent | termDays |
| ----------- | --------------- | -------- |
| Full period | Integer         | null     |
| Fragment    | null            | Days     |

---

## Usage

```js
const Splitter = require('./ContractPeriodMonthSplitter');

const contract = {
  startDate: "2025-01-15",
  endDate: "2025-12-14",
  pivotDate: "2025-02-01",
  area: 100,
  baseTotalRentRate: 50000,
  serviceRate: 10,

  freePeriods: [
    { startDate: "2025-01-15", endDate: "2025-02-14" }
  ],

  increaseRules: [
    { type: "POINT", effectiveDate: "2025-06-01", rate: 0.05 },
    { type: "ANNIVERSARY", anchorDate: "2025-01-15", rate: 0.03 }
  ]
};

const result = Splitter.splitContractPeriods(contract);

console.log(result);
```

---

## Output Example (Simplified)

```json
[
  {
    "startDate": "2025-02-01",
    "endDate": "2025-02-28",
    "monthEquivalent": 1,
    "totalRent": 50000,
    "isFreeRent": false
  },
  {
    "startDate": "2025-03-01",
    "endDate": "2025-03-15",
    "termDays": 15,
    "totalRent": 25000,
    "isFreeRent": false
  }
]
```

---

## Design Principles

### Deterministic

Same input → same output, no hidden state.

---

### Financial Integrity First

* No rounding drift
* No over/under billing
* Natural month correction guarantees accuracy

---

### Separation of Concerns

| Layer        | Responsibility     |
| ------------ | ------------------ |
| Cut Engine   | Time segmentation  |
| Weight Model | Time normalization |
| Rate Engine  | Price evolution    |
| Merge Engine | Output compression |

---

### Composable Model

The engine can be extended to support:

* Quarterly / yearly billing cycles
* Multi-tenant aggregation
* OLAP-style analytics
* Distributed billing systems

---

## Mathematical Foundation

The engine is equivalent to a:

> **Discrete time measure + piecewise constant function integration system**

Where:

* Time is segmented into measurable intervals
* Each segment carries a weight (measure)
* Pricing is a function over time
* Total billing is the integral over all segments

---

## Use Cases

* Commercial leasing systems
* Property management SaaS
* Financial billing engines
* Contract lifecycle platforms
* Revenue recognition systems

---

## Limitations

* Designed for **monthly-based billing paradigms**
* Does not yet support:

  * Weekly billing
  * Real-time adjustments within a day
  * Tax/VAT layers (should be applied externally)

---

## Roadmap

* [ ] Quarterly / yearly cycle abstraction
* [ ] SQL-compatible computation model
* [ ] Streaming billing support
* [ ] Visualization tools (timeline rendering)
* [ ] NPM package publishing

---

## License

MIT
