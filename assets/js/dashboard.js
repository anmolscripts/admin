/* 
========================================================================
   BOOTSTRAP 5 ADMIN TEMPLATE - SPARK ADMIN
   DASHBOARD CORE JAVASCRIPT MODULE
   Developed with premium UI/UX standards

   Template Name: Spark Admin
   Version: 1.0 
   Author: Spark Admin Team 
   Email: hello.sparkadmin@gmail.com
   URL: https://sparkadmin.web.id
========================================================================
*/

document.addEventListener('DOMContentLoaded', function () {
    // -----------------------------------------------------------------
    // Track and Recolor All ApexCharts on Theme Switch
    // -----------------------------------------------------------------
    window.__sparkCharts = window.__sparkCharts || [];
    if (window.ApexCharts && !window.__sparkChartsHooked) {
        window.__sparkChartsHooked = true;
        const origRender = window.ApexCharts.prototype.render;
        window.ApexCharts.prototype.render = function () {
            if (!window.__sparkCharts.includes(this)) {
                window.__sparkCharts.push(this);
            }
            const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
            const isDark = currentTheme === 'dark';
            const gridColor = isDark ? 'rgba(211, 235, 245, 0.08)' : 'rgba(32, 70, 82, 0.08)';
            const textColor = isDark ? '#A6BBC5' : '#667985';
            const tooltipTheme = isDark ? 'dark' : 'light';

            if (this.w && this.w.config) {
                // Ensure chart background is explicitly transparent so it naturally
                // inherits the glass card surface of the active theme
                this.w.config.chart = this.w.config.chart || {};
                this.w.config.chart.background = 'transparent';

                this.w.config.theme = this.w.config.theme || {};
                this.w.config.theme.mode = tooltipTheme;

                if (this.w.config.grid) this.w.config.grid.borderColor = gridColor;
                if (this.w.config.xaxis && this.w.config.xaxis.labels) {
                    this.w.config.xaxis.labels.style = this.w.config.xaxis.labels.style || {};
                    this.w.config.xaxis.labels.style.colors = textColor;
                }
                if (this.w.config.yaxis) {
                    if (Array.isArray(this.w.config.yaxis)) {
                        this.w.config.yaxis.forEach(y => {
                            if (y && y.labels) {
                                y.labels.style = y.labels.style || {};
                                y.labels.style.colors = textColor;
                            }
                        });
                    } else if (this.w.config.yaxis.labels) {
                        this.w.config.yaxis.labels.style = this.w.config.yaxis.labels.style || {};
                        this.w.config.yaxis.labels.style.colors = textColor;
                    }
                }
                if (this.w.config.legend && this.w.config.legend.labels) {
                    this.w.config.legend.labels.colors = textColor;
                }
                if (this.w.config.tooltip) {
                    this.w.config.tooltip.theme = tooltipTheme;
                }
            }
            return origRender.apply(this, arguments);
        };
        const origDestroy = window.ApexCharts.prototype.destroy;
        window.ApexCharts.prototype.destroy = function () {
            const idx = window.__sparkCharts.indexOf(this);
            if (idx > -1) {
                window.__sparkCharts.splice(idx, 1);
            }
            return origDestroy.apply(this, arguments);
        };
    }

    function updateAllSparkCharts(theme) {
        const isDark = theme === 'dark';
        const gridColor = isDark ? 'rgba(211, 235, 245, 0.08)' : 'rgba(32, 70, 82, 0.08)';
        const textColor = isDark ? '#A6BBC5' : '#667985';
        const tooltipTheme = isDark ? 'dark' : 'light';

        if (window.__sparkCharts && window.__sparkCharts.length > 0) {
            window.__sparkCharts.forEach(chart => {
                try {
                    if (chart && typeof chart.updateOptions === 'function') {
                        chart.updateOptions({
                            chart: { background: 'transparent' },
                            theme: { mode: tooltipTheme },
                            grid: { borderColor: gridColor },
                            xaxis: { labels: { style: { colors: textColor } } },
                            yaxis: { labels: { style: { colors: textColor } } },
                            legend: { labels: { colors: textColor } },
                            tooltip: { theme: tooltipTheme }
                        }, false, false);
                    }
                } catch (err) {
                    // gracefully continue
                }
            });
        }
    }

    // -----------------------------------------------------------------
    // 1. Sidebar Toggle (Desktop Collapse vs Mobile Side Drawer)
    // -----------------------------------------------------------------
    const sidebar = document.querySelector('.sidebar-wrapper');
    const toggleBtn = document.querySelector('#sidebar-toggle, .sidebar-toggle-btn');
    
    // Manage backdrop overlay for mobile/tablet drawer
    let overlay = document.querySelector('.sidebar-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'sidebar-overlay';
        document.body.appendChild(overlay);
    }

    // Restore desktop sidebar minimized state on page load if applicable
    if (window.innerWidth >= 992) {
        const savedMinimized = localStorage.getItem('spark-sidebar-minimized');
        if (savedMinimized === 'true') {
            document.body.classList.add('sidebar-minimized');
            if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
        } else if (toggleBtn) {
            toggleBtn.setAttribute('aria-expanded', 'true');
        }
    }

    function closeMobileSidebar() {
        if (sidebar) sidebar.classList.remove('show');
        if (overlay) overlay.classList.remove('show');
        document.body.classList.remove('sidebar-open');
        if (toggleBtn && window.innerWidth < 992) {
            toggleBtn.setAttribute('aria-expanded', 'false');
        }
    }

    if (toggleBtn && sidebar) {
        toggleBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            if (window.innerWidth >= 992) {
                // Desktop: Toggle collapsed icon rail
                const isMinimized = document.body.classList.toggle('sidebar-minimized');
                toggleBtn.setAttribute('aria-expanded', !isMinimized);
                localStorage.setItem('spark-sidebar-minimized', isMinimized ? 'true' : 'false');

                // Ensure mobile overlay is never active on desktop
                overlay.classList.remove('show');
                document.body.classList.remove('sidebar-open');

                // Dispatch resize event so ApexCharts redraw smoothly
                setTimeout(() => {
                    window.dispatchEvent(new Event('resize'));
                }, 300);
            } else {
                // Mobile and tablet: Toggle side drawer
                const isOpen = sidebar.classList.toggle('show');
                overlay.classList.toggle('show', isOpen);
                document.body.classList.toggle('sidebar-open', isOpen);
                toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            }
        });

        // Close sidebar when clicking on backdrop overlay
        overlay.addEventListener('click', closeMobileSidebar);

        // Close sidebar with Escape key on mobile/tablet
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && sidebar.classList.contains('show')) {
                closeMobileSidebar();
                toggleBtn.focus();
            }
        });

        // Responsive boundary auto-cleanup on window resize
        window.addEventListener('resize', function () {
            if (window.innerWidth >= 992) {
                closeMobileSidebar();
            }
        });
    }

    // -----------------------------------------------------------------
    // 1b. Light / Dark Theme Switcher
    // -----------------------------------------------------------------
    const themeToggleBtn = document.querySelector('#theme-toggle');
    const themeToggleIcon = document.querySelector('#theme-toggle-icon');

    function applyTheme(theme, isUserAction) {
        document.documentElement.setAttribute('data-theme', theme);
        if (isUserAction) {
            try {
                localStorage.setItem('spark-theme', theme);
            } catch (e) {}
        }
        const isDark = theme === 'dark';
        if (themeToggleBtn) {
            themeToggleBtn.setAttribute('title', isDark ? 'Switch to light mode' : 'Switch to dark mode');
            themeToggleBtn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
        }
        if (themeToggleIcon) {
            themeToggleIcon.className = isDark ? 'bi bi-sun' : 'bi bi-moon-stars';
        }
        updateAllSparkCharts(theme);
        window.dispatchEvent(new CustomEvent('spark:theme-changed', { detail: { theme } }));
    }

    // Sync button state on initial load
    const currentActiveTheme = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(currentActiveTheme, false);

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', function (e) {
            e.preventDefault();
            const curr = document.documentElement.getAttribute('data-theme') || 'light';
            const next = curr === 'dark' ? 'light' : 'dark';
            applyTheme(next, true);
        });
    }


    // -----------------------------------------------------------------
    // 2. Revenue Chart (Vertical Bar Chart - Income vs Expenses)
    // -----------------------------------------------------------------
    const revenueChartEl = document.querySelector('#revenue-chart');
    if (revenueChartEl) {
        const revenueChartOptions = {
            series: [
                {
                    name: 'Income',
                    data: [44, 55, 41, 67, 52, 70, 61, 85]
                },
                {
                    name: 'Expenses',
                    data: [23, 33, 30, 48, 34, 45, 40, 45]
                }
            ],
            chart: {
                type: 'bar',
                height: 220,
                stacked: false,
                background: 'transparent',
                toolbar: {
                    show: false
                },
                zoom: {
                    enabled: false
                },
                fontFamily: 'Plus Jakarta Sans, sans-serif'
            },
            colors: ['#072F1F', '#B4F105'], // Dark Green (Income), Lime Green (Expenses)
            states: {
                hover: {
                    filter: {
                        type: 'none'
                    }
                }
            },
            plotOptions: {
                bar: {
                    horizontal: false,
                    columnWidth: '48%',
                    borderRadius: 0
                },
            },
            dataLabels: {
                enabled: false
            },
            stroke: {
                show: true,
                width: 2,
                colors: ['transparent']
            },
            legend: {
                show: false // Custom legends are drawn statically in HTML to match reference layout
            },
            grid: {
                borderColor: '#E9EFEF',
                strokeDashArray: 4,
                yaxis: {
                    lines: {
                        show: true
                    }
                },
                xaxis: {
                    lines: {
                        show: false
                    }
                },
                padding: {
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0
                }
            },
            xaxis: {
                categories: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'],
                labels: {
                    style: {
                        colors: '#6C7E75',
                        fontSize: '11px',
                        fontWeight: 500
                    }
                },
                axisBorder: {
                    show: false
                },
                axisTicks: {
                    show: false
                }
            },
            yaxis: {
                labels: {
                    show: false // Hides absolute numbers to match simplified reference chart style
                }
            },
            fill: {
                opacity: 1
            },
            tooltip: {
                y: {
                    formatter: function (val) {
                        return "$ " + val + ".000";
                    }
                },
                theme: 'dark'
            }
        };

        const revenueChart = new ApexCharts(revenueChartEl, revenueChartOptions);
        revenueChart.render();
    }

    // -----------------------------------------------------------------
    // 3. Total View Performance Chart (Donut Chart)
    // -----------------------------------------------------------------
    const viewsChartEl = document.querySelector('#views-chart');
    if (viewsChartEl) {
        const viewsChartOptions = {
            series: [68, 23, 16], // View Count (68%), Percentage (23%), Sales (16%)
            chart: {
                type: 'donut',
                height: 250,
                background: 'transparent',
                fontFamily: 'Plus Jakarta Sans, sans-serif'
            },
            labels: ['View Count', 'Percentage', 'Sales'],
            colors: ['#B4F105', '#051C12', '#F97316'], // Lime, Forest Dark, Orange
            states: {
                hover: {
                    filter: {
                        type: 'none'
                    }
                }
            },
            legend: {
                show: false // Custom HTML legend used below the chart
            },
            dataLabels: {
                enabled: false
            },
            plotOptions: {
                pie: {
                    donut: {
                        size: '72%',
                        background: 'transparent',
                        labels: {
                            show: true,
                            name: {
                                show: true,
                                fontSize: '12px',
                                fontWeight: 500,
                                color: '#6C7E75',
                                offsetY: -8
                            },
                            value: {
                                show: true,
                                fontSize: '26px',
                                fontWeight: 800,
                                color: '#0B130F',
                                offsetY: 8,
                                formatter: function (val) {
                                    return val + "%";
                                }
                            },
                            total: {
                                show: true,
                                label: 'Total Count',
                                fontSize: '11px',
                                fontWeight: 500,
                                color: '#6C7E75',
                                formatter: function (w) {
                                    return '565K';
                                }
                            }
                        }
                    }
                }
            },
            tooltip: {
                theme: 'dark'
            }
        };

        const viewsChart = new ApexCharts(viewsChartEl, viewsChartOptions);
        viewsChart.render();
    }

    // -----------------------------------------------------------------
    // 4. Sparkline Charts (Net Income & Total Return)
    // -----------------------------------------------------------------
    const incomeSparkOptions = {
        series: [{
            name: 'Net Income',
            data: [45, 51, 46, 58, 50, 62, 55, 72, 65, 79, 70, 85]
        }],
        chart: {
            type: 'area',
            height: 45,
            background: 'transparent',
            sparkline: {
                enabled: true
            },
            fontFamily: 'Plus Jakarta Sans, sans-serif'
        },
        stroke: {
            curve: 'smooth',
            width: 2
        },
        fill: {
            opacity: 0.1,
            type: 'solid'
        },
        colors: ['#22C55E'], // Green color matching trend-up
        tooltip: {
            fixed: {
                enabled: false
            },
            x: {
                show: false
            },
            y: {
                title: {
                    formatter: function (seriesName) {
                        return '';
                    }
                }
            },
            marker: {
                show: false
            }
        }
    };

    const returnSparkOptions = {
        series: [{
            name: 'Total Return',
            data: [50, 48, 55, 45, 40, 38, 42, 35, 30, 28, 32, 24]
        }],
        chart: {
            type: 'area',
            height: 45,
            background: 'transparent',
            sparkline: {
                enabled: true
            },
            fontFamily: 'Plus Jakarta Sans, sans-serif'
        },
        stroke: {
            curve: 'smooth',
            width: 2
        },
        fill: {
            opacity: 0.1,
            type: 'solid'
        },
        colors: ['#EF4444'], // Red color matching trend-down
        tooltip: {
            fixed: {
                enabled: false
            },
            x: {
                show: false
            },
            y: {
                title: {
                    formatter: function (seriesName) {
                        return '';
                    }
                }
            },
            marker: {
                show: false
            }
        }
    };

    const incomeSparkEl = document.querySelector('#income-sparkline');
    if (incomeSparkEl) {
        const incomeSpark = new ApexCharts(incomeSparkEl, incomeSparkOptions);
        incomeSpark.render();
    }

    const returnSparkEl = document.querySelector('#return-sparkline');
    if (returnSparkEl) {
        const returnSpark = new ApexCharts(returnSparkEl, returnSparkOptions);
        returnSpark.render();
    }

    // -----------------------------------------------------------------
    // 5. Flatpickr Date Range Picker Initialization
    // -----------------------------------------------------------------
    const datePickerTrigger = document.querySelector('#date-picker-trigger');
    const selectedRangeText = document.querySelector('#selected-date-range');
    
    if (datePickerTrigger && selectedRangeText) {
        flatpickr(datePickerTrigger, {
            mode: 'range',
            dateFormat: 'Y-m-d',
            defaultDate: ['2026-01-12', '2026-01-23'],
            onValueUpdate: function (selectedDates, dateStr, instance) {
                if (selectedDates.length === 2) {
                    const startStr = instance.formatDate(selectedDates[0], 'F j, Y');
                    const endStr = instance.formatDate(selectedDates[1], 'F j, Y');
                    selectedRangeText.textContent = `${startStr} - ${endStr}`;
                } else if (selectedDates.length === 1) {
                    const startStr = instance.formatDate(selectedDates[0], 'F j, Y');
                    selectedRangeText.textContent = startStr;
                }
            }
        });
    }

    // -----------------------------------------------------------------
    // 6. Desktop Sidebar Minimize Interaction
    // -----------------------------------------------------------------
    const desktopToggleBtn = document.querySelector('#desktop-sidebar-toggle');
    if (desktopToggleBtn) {
        desktopToggleBtn.addEventListener('click', function () {
            const isMinimized = document.body.classList.toggle('sidebar-minimized');
            localStorage.setItem('spark-sidebar-minimized', isMinimized ? 'true' : 'false');
            
            // Toggle icon direction
            const icon = desktopToggleBtn.querySelector('i');
            if (icon) {
                if (isMinimized) {
                    icon.className = 'bi bi-chevron-bar-right';
                } else {
                    icon.className = 'bi bi-chevron-bar-left';
                }
            }
            
            // Trigger a window resize event so that charts (ApexCharts) redraw correctly
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
            }, 300);
        });
    }

    // -----------------------------------------------------------------
    // 7. Fullscreen Toggle Interaction
    // -----------------------------------------------------------------
    const fullscreenBtn = document.querySelector('#btn-fullscreen');
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', function () {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().then(() => {
                    updateFullscreenIcon(true);
                }).catch(err => {
                    console.error(`Error attempting to enable fullscreen mode: ${err.message}`);
                });
            } else {
                document.exitFullscreen().then(() => {
                    updateFullscreenIcon(false);
                }).catch(err => {
                    console.error(`Error attempting to exit fullscreen mode: ${err.message}`);
                });
            }
        });

        function updateFullscreenIcon(isFullscreen) {
            const icon = fullscreenBtn.querySelector('i');
            if (icon) {
                if (isFullscreen) {
                    icon.className = 'bi bi-fullscreen-exit';
                } else {
                    icon.className = 'bi bi-arrows-fullscreen';
                }
            }
        }

        // Listen for browser native fullscreen changes (e.g. Esc key)
        document.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) {
                updateFullscreenIcon(true);
            } else {
                updateFullscreenIcon(false);
            }
        });
    }
});
