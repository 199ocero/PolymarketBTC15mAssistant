// app.js - PolyBot Dashboard Connector

document.addEventListener('DOMContentLoaded', () => {
    let socket;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketUrl = `${protocol}//${window.location.host}`;

    const elements = {
        statusDot: document.getElementById('status-dot'),
        statusText: document.getElementById('status-text'),
        marketName: document.getElementById('market-name'),
        marketSlug: document.getElementById('market-slug'),
        timeLeft: document.getElementById('market-time-left'),
        signalSide: document.getElementById('signal-side'),
        signalPhase: document.getElementById('signal-phase'),
        convictionPct: document.getElementById('conviction-pct'),
        convictionProgress: document.getElementById('conviction-progress'),
        adviceLine: document.getElementById('advice-line'),
        binancePrice: document.getElementById('binance-price'),
        currentPrice: document.getElementById('current-price'),
        priceGap: document.getElementById('price-gap'),
        strikePrice: document.getElementById('strike-price'),
        polyUp: document.getElementById('poly-up'),
        polyDown: document.getElementById('poly-down'),
        totalEquity: document.getElementById('total-equity'),
        dailyPnl: document.getElementById('daily-pnl'),
        paperBalance: document.getElementById('paper-balance'),
        winRateToday: document.getElementById('win-rate-today'),
        winRateTotal: document.getElementById('win-rate-total'),
        unrealizedPnl: document.getElementById('unrealized-pnl'),
        indHeiken: document.getElementById('ind-heiken'),
        indRsi: document.getElementById('ind-rsi'),
        indMacd: document.getElementById('ind-macd'),
        indVwap: document.getElementById('ind-vwap'),
        indEma: document.getElementById('ind-ema'),
        activityFeed: document.getElementById('activity-feed'),
        clearLogsBtn: document.getElementById('clear-logs'),
        etTime: document.getElementById('et-time'),
        sessionName: document.getElementById('session-name'),
        tradesList: document.getElementById('recent-trades-list')
    };

    function connect() {
        console.log(`Connecting to ${socketUrl}...`);
        socket = new WebSocket(socketUrl);

        socket.onopen = () => {
            elements.statusDot.classList.add('connected');
            elements.statusText.textContent = 'Connected Live';
            addLogEntry('System connected to backend.', 'system');
        };

        socket.onclose = () => {
            elements.statusDot.classList.remove('connected');
            elements.statusText.textContent = 'Disconnected';
            addLogEntry('Lost connection. Retrying in 3s...', 'system');
            setTimeout(connect, 3000);
        };

        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'state') {
                    updateUI(data.payload);
                } else if (data.type === 'activity') {
                    addLogEntry(data.payload.msg, data.payload.type);
                }
            } catch (err) {
                console.error('Error parsing pulse:', err);
            }
        };
    }

    function addLogEntry(msg, type = 'default') {
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        entry.innerHTML = `<span class="log-timestamp">[${ts}]</span> ${msg}`;
        
        elements.activityFeed.appendChild(entry);
        elements.activityFeed.scrollTop = elements.activityFeed.scrollHeight;
        
        // Prune old logs
        while (elements.activityFeed.children.length > 50) {
            elements.activityFeed.removeChild(elements.activityFeed.firstChild);
        }
    }

    function updateUI(state) {
        // Market Info
        elements.marketName.textContent = state.marketName || 'Polymarket Active';
        elements.marketSlug.textContent = state.marketSlug || '-';
        elements.timeLeft.textContent = state.timeLeftStr || '00:00';
        
        if (state.timeLeftMin < 5) elements.timeLeft.classList.add('pulsing');
        else elements.timeLeft.classList.remove('pulsing');

        // Signal
        const side = state.side || 'NEUTRAL';
        elements.signalSide.textContent = side === 'UP' ? 'BUY UP ▲' : side === 'DOWN' ? 'BUY DOWN ▼' : 'NO TRADE';
        elements.signalSide.className = side === 'UP' ? 'side-long' : side === 'DOWN' ? 'side-short' : 'side-neutral';
        elements.signalPhase.textContent = state.phase || '-';
        elements.adviceLine.textContent = state.advice || 'Analyzing...';
        
        const conv = state.conviction || 0;
        elements.convictionPct.textContent = `${(conv * 100).toFixed(0)}%`;
        elements.convictionProgress.style.width = `${conv * 100}%`;
        
        // Dynamic Signal Card Coloring
        const signalCard = elements.signalSide.closest('.card');
        if (signalCard) {
            signalCard.classList.remove('long', 'short', 'neutral');
            const phaseClass = side === 'UP' ? 'long' : side === 'DOWN' ? 'short' : 'neutral';
            signalCard.classList.add(phaseClass);
        }

        // Prices
        updatePrice(elements.binancePrice, state.binancePrice, 0, '$');
        updatePrice(elements.currentPrice, state.currentPrice, 2, '$');
        updatePrice(elements.strikePrice, state.strikePrice, 2, '$');
        
        if (state.gap !== undefined && elements.priceGap) {
            elements.priceGap.textContent = (state.gap >= 0 ? '+' : '') + '$' + state.gap.toFixed(2);
            elements.priceGap.style.color = state.gap >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        }

        if (elements.polyUp) elements.polyUp.textContent = state.polyUp !== null ? `${state.polyUp}¢` : '--¢';
        if (elements.polyDown) elements.polyDown.textContent = state.polyDown !== null ? `${state.polyDown}¢` : '--¢';

        // Account
        elements.totalEquity.textContent = `$${state.totalEquity?.toFixed(2) || '0.00'}`;
        elements.dailyPnl.textContent = (state.dailyPnl >= 0 ? '+' : '-') + '$' + Math.abs(state.dailyPnl || 0).toFixed(2);
        elements.dailyPnl.style.color = state.dailyPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        elements.paperBalance.textContent = `$${state.paperBalance?.toFixed(2) || '0.00'}`;
        
        if (state.winStats) {
            const today = state.winStats.today;
            const overall = state.winStats.overall;
            
            elements.winRateToday.textContent = `${today.rate.toFixed(0)}% (${today.wins}/${today.total})`;
            elements.winRateToday.style.color = today.rate >= 50 ? 'var(--accent-green)' : today.total > 0 ? 'var(--accent-red)' : 'var(--text-secondary)';
            
            elements.winRateTotal.textContent = `${overall.rate.toFixed(0)}% (${overall.wins}/${overall.total})`;
            elements.winRateTotal.style.color = overall.rate >= 50 ? 'var(--accent-green)' : overall.total > 0 ? 'var(--accent-red)' : 'var(--text-secondary)';
        }

        if (state.position) {
            const side = state.position.side || '';
            elements.unrealizedPnl.textContent = (state.posPnl >= 0 ? '+' : '-') + '$' + Math.abs(state.posPnl || 0).toFixed(2) + ` (${side})`;
            elements.unrealizedPnl.style.color = state.posPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        } else {
            elements.unrealizedPnl.textContent = '$0.00';
            elements.unrealizedPnl.style.color = 'var(--text-secondary)';
        }

        // Indicators
        updateIndicator(elements.indHeiken, state.indHeiken);
        updateIndicator(elements.indRsi, state.indRsi);
        updateIndicator(elements.indMacd, state.indMacd);
        updateIndicator(elements.indVwap, state.indVwap);
        updateIndicator(elements.indEma, state.indEma);

        // Footer
        if (state.etTime) elements.etTime.textContent = state.etTime + ' ET';
        if (state.session) {
            if (elements.sessionName) elements.sessionName.textContent = 'Session: ' + state.session;
            const footerSession = document.getElementById('footer-session-name');
            if (footerSession) footerSession.textContent = state.session;
        }

        // Recent Trades
        renderRecentTrades(state.recentTrades);
    }

    function renderRecentTrades(trades) {
        if (!elements.tradesList) return;
        if (!trades || trades.length === 0) {
            elements.tradesList.innerHTML = '<div class="no-trades">No settled trades yet</div>';
            return;
        }

        elements.tradesList.innerHTML = trades.map(t => {
            const pnl = parseFloat(t.pnl) || 0;
            const pnlColor = pnl > 0 ? 'var(--accent-green)' : 'var(--accent-red)';
            const sign = pnl >= 0 ? '+' : '';
            const sideClass = t.side.toLowerCase();
            const time = new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            return `
                <div class="trade-row">
                    <div class="trade-info">
                        <span class="trade-side side-${sideClass}">${t.side}</span>
                        <span class="trade-time">${time}</span>
                    </div>
                    <div class="trade-pnl" style="color: ${pnlColor}">
                        ${sign}$${Math.abs(pnl).toFixed(2)}
                    </div>
                </div>
            `;
        }).join('');
    }

    function updatePrice(el, val, digits, prefix = '') {
        if (!el || val === null || val === undefined) return;
        const currentText = el.textContent.replace(/[^\d.-]/g, '');
        const currentVal = parseFloat(currentText) || 0;
        
        el.textContent = `${prefix}${val.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
        
        if (val > currentVal) {
            el.classList.add('up-flash');
            setTimeout(() => el.classList.remove('up-flash'), 500);
        } else if (val < currentVal) {
            el.classList.add('down-flash');
            setTimeout(() => el.classList.remove('down-flash'), 500);
        }
    }

    function updateIndicator(el, info) {
        if (!el || !info) return;
        el.textContent = info.val || '-';
        el.className = 'ind-val ' + (info.sentiment || 'neutral').toLowerCase();
    }

    elements.clearLogsBtn.onclick = () => {
        elements.activityFeed.innerHTML = '';
        addLogEntry('Logs cleared.', 'system');
    };

    connect();
});
