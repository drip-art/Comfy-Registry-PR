/**
 * Error Collector - Monitors child workspace for errors and collects them
 *
 * Strategy: fs.watch for fast event-driven response, plus a slow safety-net
 * poll (default 60s) since recursive watch can drop events on some FS layers
 * and inside containers.
 */

import { readdir, readFile, appendFile, mkdir, watch } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

export interface ErrorCollectorOptions {
  workspaceDir: string;
  outputLogPath: string;
  onError?: (errorPath: string, content: string) => void;
  checkInterval?: number; // milliseconds
}

export class ErrorCollector {
  private workspaceDir: string;
  private outputLogPath: string;
  private onError?: (errorPath: string, content: string) => void;
  private checkInterval: number;
  private intervalId?: Timer;
  private watchAbort?: AbortController;
  private processedErrors = new Set<string>();
  private debounceTimers = new Map<string, Timer>();

  constructor(options: ErrorCollectorOptions) {
    this.workspaceDir = options.workspaceDir;
    this.outputLogPath = options.outputLogPath;
    this.onError = options.onError;
    // Slow safety-net poll. Real-time detection comes from fs.watch.
    this.checkInterval = options.checkInterval || 60_000;
  }

  async start() {
    // Ensure output directory exists
    await mkdir(path.dirname(this.outputLogPath), { recursive: true });

    // Initial scan
    await this.scanForErrors();

    // Event-driven watcher (recursive). Bursts of writes are coalesced via
    // a 500ms per-file debounce.
    if (existsSync(this.workspaceDir)) {
      this.watchAbort = new AbortController();
      (async () => {
        try {
          const watcher = watch(this.workspaceDir, {
            recursive: true,
            signal: this.watchAbort!.signal,
          });
          for await (const ev of watcher) {
            const filename = ev.filename;
            if (!filename) continue;
            const lower = filename.toLowerCase();
            const looksLikeError =
              lower.includes("error") ||
              /-errors?\.md$/i.test(filename) ||
              /tools[_-]errors\.md$/i.test(filename);
            if (!looksLikeError) continue;

            const full = path.join(this.workspaceDir, filename);
            const prev = this.debounceTimers.get(full);
            if (prev) clearTimeout(prev);
            this.debounceTimers.set(
              full,
              setTimeout(() => {
                this.debounceTimers.delete(full);
                this.processErrorFile(full).catch(() => {});
              }, 500),
            );
          }
        } catch (err: unknown) {
          if ((err as { name?: string })?.name !== "AbortError") {
            console.error("[ErrorCollector] watch failed, falling back to poll only:", err);
          }
        }
      })();
    }

    // Periodic scanning (safety net for FS layers that drop watch events)
    this.intervalId = setInterval(() => {
      this.scanForErrors().catch((err) => {
        console.error("[ErrorCollector] Scan failed:", err);
      });
    }, this.checkInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.watchAbort?.abort();
    this.watchAbort = undefined;
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }

  private async scanForErrors() {
    const errorPatterns = [
      "**/ERRORS.md",
      "**/ERROR*.md",
      "**/*-ERRORS.md",
      "**/.logs/*error*.log",
      "**/.logs/*ERROR*.log",
    ];

    for (const pattern of errorPatterns) {
      await this.findAndProcessErrors(pattern);
    }
  }

  private async findAndProcessErrors(_pattern: string) {
    try {
      // Simple glob-like search - check common locations
      const logsDir = path.join(this.workspaceDir, ".logs");
      const rootDir = this.workspaceDir;

      const dirsToCheck = [logsDir, rootDir];

      for (const dir of dirsToCheck) {
        if (!existsSync(dir)) continue;

        const files = await readdir(dir).catch(() => []);

        for (const file of files) {
          const filePath = path.join(dir, file);

          // Check if file matches error patterns
          const isErrorFile =
            file.includes("ERROR") ||
            file.includes("error") ||
            file.match(/.*-ERRORS?\.md$/i) ||
            file.match(/TOOLS[_-]ERRORS\.md$/i);

          if (isErrorFile && !this.processedErrors.has(filePath)) {
            await this.processErrorFile(filePath);
          }
        }
      }
    } catch (err) {
      console.error("[ErrorCollector] Error scanning:", err);
    }
  }

  private async processErrorFile(errorPath: string) {
    // Skip ephemeral atomic-write temp files (`*.tmp.<pid>.<ts>`). The
    // watcher fires on the temp's create; by the time the 500ms debounce
    // elapses, the writer has rename()'d it away and the read ENOENTs.
    // That's the expected steady-state, not an error worth logging.
    if (/\.tmp(?:\.[^/]+)?$/.test(errorPath)) return;

    try {
      const content = await readFile(errorPath, "utf-8");

      if (!content.trim()) {
        return; // Skip empty files
      }

      // Mark as processed
      this.processedErrors.add(errorPath);

      // Log to output
      const timestamp = new Date().toISOString();
      const relPath = path.relative(this.workspaceDir, errorPath);
      const logEntry = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[${timestamp}] Error found in: ${relPath}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${content}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;

      await appendFile(this.outputLogPath, logEntry);

      // Call callback if provided
      if (this.onError) {
        this.onError(errorPath, content);
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT") return; // file was removed mid-debounce; fine
      console.error(`[ErrorCollector] Failed to process ${errorPath}:`, err);
    }
  }
}
