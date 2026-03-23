# Registered Accounts Simulator

A Canadian personal finance simulator for modeling RRSP, TFSA, and RESP growth, withdrawal strategies, and tax optimization — built for Ontario residents with 2026 tax brackets.

🔗 **[Live Demo](https://m-tahmid.github.io/registered-accounts-sim)**

---

## Features

### RRSP Simulator
- Compare three strategies side-by-side:
  - **Claim Immediately** — contribute and claim the deduction every year
  - **Optimized Deferred** — pool deductions and claim during peak-income years to maximize refund value
  - **Non-Reg Baseline** — invest the same gross dollars in a taxable account for a fair apples-to-apples comparison
- Multi-phase income and withdrawal scheduling
- Scheduled withdrawal mode and until-depletion mode
- Income-splitting across multiple people on withdrawal
- Accounts for existing RRSP room and balances

### TFSA Simulator
- Tracks accumulated room based on birth year and Canadian residency start year
- Applies real historical TFSA annual limits (2009–present) with projected future limits
- Multi-phase contribution and withdrawal scheduling
- Until-depletion simulation with year-by-year breakdown
- Spouse/partner support with separate room tracking

### RESP Simulator
- Models CESG (Canada Education Savings Grant) — 20% match on first $2,500/yr, up to $7,200 lifetime
- Multi-child support with individual contribution phases
- EAP (Educational Assistance Payment) tax modeling based on years in school and student income
- AIP (Accumulated Income Payment) scenario with marginal tax + 20% federal penalty
- Comparison against a non-registered alternative investment
- Subscriber income-aware tax calculations

### Withdrawal Plan (Optimizer)
- Models optimal draw-down order across RRSP, TFSA, and Non-Reg accounts
- Spouse/partner support for income-splitting
- Emigration mode — models departure tax events:
  - RRSP: 25% flat withholding post-departure
  - TFSA: tax-free transfer, zero Canadian obligation
  - Non-Reg: deemed disposition on departure, ACB reset
- Year-by-year plan table with tax, net, and balance columns
- Emigration snapshot showing what each account looks like at departure

---

## Tax Model

All calculations use **Ontario 2026 combined federal + provincial marginal brackets**:

| Bracket | Rate |
|---|---|
| Up to $17,000 | 0.00% |
| $17,001 – $49,958 | 20.05% |
| $49,959 – $57,375 | 24.15% |
| $57,376 – $100,392 | 31.48% |
| $100,393 – $111,733 | 37.48% |
| $111,734 – $150,000 | 43.41% |
| $150,001 – $155,625 | 44.41% |
| $155,626 – $220,000 | 48.97% |
| $220,001+ | 53.53% |

Capital gains use a **50% inclusion rate**. Non-reg withdrawals apply a proportional gain/cost-basis split on each withdrawal.

---

## Tech Stack

- **React 19** with Vite 8
- **Pure CSS** — no UI component library
- Deployed via **GitHub Pages** using `gh-pages`

---

## Getting Started

```bash
# Clone the repo
git clone https://github.com/m-tahmid/registered-accounts-sim.git
cd registered-accounts-sim/registered-accounts-sim

# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build

# Deploy to GitHub Pages
npm run deploy
```

---

## Project Structure

```
registered-accounts-sim/
├── src/
│   ├── App.jsx          # All simulators, calculations, and UI
│   ├── App.css          # Styles
│   ├── main.jsx         # Entry point
│   └── index.css        # Global styles
├── public/
│   └── ...              # Favicons, manifest, icons
├── images/
│   └── logo.png
└── index.html
```

---

## Disclaimer

This tool is for **educational and planning purposes only**. It is not financial or tax advice. Tax rules, TFSA limits, and bracket thresholds change over time — verify figures with a qualified advisor or the CRA before making financial decisions.
