/* ==========================================================================
   SPARK ADMIN ERP — GLOBAL AJAX PROGRESS LOADER & SKELETON MANAGER
   - Provides instant feedback on background operations and page interactions.
   - Automatically monitors fetch and XMLHttpRequest life cycles.
   - Provides lightweight enterprise toast notifications and skeleton renderers.
   ========================================================================== */

(function () {
    'use strict';

    let activeRequests = 0;
    let progressBar = null;
    let progressTimer = null;
    let currentProgress = 0;

    function getOrCreateProgressBar() {
        if (!progressBar) {
            progressBar = document.getElementById('spark-page-progress');
            if (!progressBar) {
                progressBar = document.createElement('div');
                progressBar.id = 'spark-page-progress';
                document.body.appendChild(progressBar);
            }
        }
        return progressBar;
    }

    function startProgress() {
        const bar = getOrCreateProgressBar();
        if (activeRequests === 1) {
            currentProgress = 15;
            bar.style.width = currentProgress + '%';
            bar.classList.add('active');

            clearInterval(progressTimer);
            progressTimer = setInterval(function () {
                if (currentProgress < 85) {
                    currentProgress += Math.random() * 12;
                    if (currentProgress > 85) currentProgress = 85;
                    bar.style.width = currentProgress + '%';
                }
            }, 200);
        }
    }

    function finishProgress() {
        if (activeRequests <= 0) {
            activeRequests = 0;
            clearInterval(progressTimer);
            const bar = getOrCreateProgressBar();
            bar.style.width = '100%';
            setTimeout(function () {
                bar.classList.remove('active');
                setTimeout(function () {
                    bar.style.width = '0%';
                }, 300);
            }, 250);
        }
    }

    function onRequestStart() {
        activeRequests++;
        startProgress();
    }

    function onRequestEnd() {
        activeRequests--;
        finishProgress();
    }

    // Intercept Fetch API
    if (window.fetch) {
        const origFetch = window.fetch;
        window.fetch = function () {
            onRequestStart();
            return origFetch.apply(this, arguments)
                .then(function (response) {
                    onRequestEnd();
                    return response;
                })
                .catch(function (error) {
                    onRequestEnd();
                    throw error;
                });
        };
    }

    // Intercept XMLHttpRequest
    if (window.XMLHttpRequest) {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function () {
            this._sparkTracked = true;
            return origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function () {
            if (this._sparkTracked) {
                onRequestStart();
                const onComplete = () => {
                    if (this._sparkTracked) {
                        this._sparkTracked = false;
                        onRequestEnd();
                    }
                };
                this.addEventListener('loadend', onComplete, { once: true });
                this.addEventListener('error', onComplete, { once: true });
                this.addEventListener('abort', onComplete, { once: true });
            }
            return origSend.apply(this, arguments);
        };
    }

    // Global SparkLoader API
    window.SparkLoader = {
        start: function () {
            onRequestStart();
        },
        done: function () {
            onRequestEnd();
        },
        toast: function (message, type = 'success', duration = 3500) {
            let container = document.getElementById('spark-toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'spark-toast-container';
                container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;display:flex;flex-direction:column;gap:10px;pointer-events:none;';
                document.body.appendChild(container);
            }

            const toast = document.createElement('div');
            toast.className = 'spark-fade-in shadow-lg';
            
            let bg = '#0f172a';
            let icon = 'bi-info-circle-fill text-info';
            if (type === 'success') {
                bg = '#064e3b';
                icon = 'bi-check-circle-fill text-success';
            } else if (type === 'danger' || type === 'error') {
                bg = '#7f1d1d';
                icon = 'bi-exclamation-triangle-fill text-danger';
            } else if (type === 'warning') {
                bg = '#78350f';
                icon = 'bi-exclamation-circle-fill text-warning';
            }

            toast.style.cssText = `background:${bg};color:#ffffff;padding:12px 18px;border-radius:10px;font-size:14px;font-weight:500;display:flex;align-items:center;gap:10px;pointer-events:auto;min-width:280px;max-width:420px;border:1px solid rgba(255,255,255,0.15);`;
            toast.innerHTML = `<i class="bi ${icon} fs-5"></i><span class="flex-grow-1">${message}</span><button type="button" style="background:none;border:none;color:#fff;opacity:0.7;cursor:pointer;font-size:16px;" onclick="this.parentElement.remove()">&times;</button>`;
            
            container.appendChild(toast);
            setTimeout(function () {
                toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(10px)';
                setTimeout(function () {
                    toast.remove();
                }, 400);
            }, duration);
        },
        renderSkeletonTable: function (tbodySelector, rowCount = 5, colCount = 6) {
            const tbody = typeof tbodySelector === 'string' ? document.querySelector(tbodySelector) : tbodySelector;
            if (!tbody) return;
            let html = '';
            for (let r = 0; r < rowCount; r++) {
                html += '<tr>';
                for (let c = 0; c < colCount; c++) {
                    const width = (c === 0) ? '60%' : (c === colCount - 1 ? '40%' : '80%');
                    html += `<td><div class="skeleton-line sm" style="width: ${width}; margin: 4px 0;"></div></td>`;
                }
                html += '</tr>';
            }
            tbody.innerHTML = html;
        }
    };
})();

