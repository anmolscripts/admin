'use strict';
if (require.main === module) {
    require('./lib/production-install').installProduction(process.argv.slice(2)).catch(() => {
        // The orchestrator reports a sanitized message; never dump driver errors.
        process.exitCode = 1;
    });
}
