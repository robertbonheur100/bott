# 🤖 BonheurBot — Smart Trading Robot

Trading bot pou Deriv, Binance, MT5 ak 11 strategies (EMA, RSI, MACD, BB, Breakout, FVG, Fibonacci, Stochastic, Ichimoku, VWAP, SuperTrend).

## 🚀 Deploy sou Railway (5 minit, gratis)

### Etap 1 — Mete kòd sou GitHub
1. Ale sou **github.com** → kreye kont gratis si ou pa gen youn
2. Klike **"New repository"** → non: `bonheurbot` → Public → **Create**
3. Klike **"uploading an existing file"**
4. Glise tout fichye yo (server.js, package.json, public/) → **Commit**

### Etap 2 — Deploy sou Railway
1. Ale sou **railway.app** → konekte ak GitHub
2. Klike **"New Project"** → **"Deploy from GitHub repo"**
3. Chwazi `bonheurbot` → Railway ap deploy otomatik!
4. Ale nan **Settings → Networking → Generate Domain**
5. Kopye URL la (ex: `https://bonheurbot-production.up.railway.app`)

### Etap 3 — Ouvri nan Chrome
Tape URL Railway la nan Chrome — BonheurBot ap louvri!

## 📁 Fichye yo
```
bonheurbot/
├── server.js          ← Backend Node.js (trading logic)
├── package.json       ← Dependencies
├── .gitignore
└── public/
    └── index.html     ← Frontend Dashboard
```

## 🔧 Strategies disponib
- 🔥 ALL (Confluence — pi egzak)
- EMA Cross (9/21/50)
- RSI (oversold/overbought)
- MACD signal crossover
- Bollinger Bands
- Breakout (20-period)
- FVG (Fair Value Gap)
- Fibonacci (23.6% → 78.6%)
- Stochastic K%D
- Ichimoku Cloud
- VWAP

## ✅ Brokers
- **Deriv** — WebSocket dirèk — trade Synthetics + Forex
- **Binance** — REST API ak HMAC signing
- **MT5** — via MetaAPI.cloud
