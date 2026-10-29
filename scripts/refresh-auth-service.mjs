export * from '../proxy/refresh-service.mjs';
import path from 'node:path';
import { createRefreshService } from '../proxy/refresh-service.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    const service = createRefreshService();
    service.start();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
        await service.stop();
        process.exit(0);
    });
}
