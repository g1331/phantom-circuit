import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Store, Fault, redact } from './store.ts';
import { Workspaces } from './workspaces.ts';
import { shellCommand, terminate } from './process.ts';

export class Previews {
  private children = new Map<string, ChildProcess>();
  private busy = new Set<string>();
  private controllers = new Map<string, AbortController>();
  private starts = new Map<string, Promise<{ url: string }>>();
  constructor(
    private store: Store,
    private workspaces: Workspaces,
  ) {}
  async stop(repoId: string) {
    this.controllers.get(repoId)?.abort();
    await this.stopChild(repoId);
    await this.starts.get(repoId)?.catch(() => {});
    this.store.patchRepo(repoId, { preview: { status: 'stopped' } });
  }
  private async stopChild(repoId: string) {
    const child = this.children.get(repoId);
    this.children.delete(repoId);
    if (child) await terminate(child);
  }
  async close() {
    await Promise.all(
      [...new Set([...this.children.keys(), ...this.controllers.keys()])].map((id) =>
        this.stop(id),
      ),
    );
  }
  private freePort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = createServer();
      s.once('error', () => reject(new Fault(`体验端口 ${port} 已被占用，请修改仓库端口配置`)));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
    });
  }
  async start(repoId: string) {
    if (this.busy.has(repoId)) throw new Fault('体验环境正在启动', 409);
    this.busy.add(repoId);
    const controller = new AbortController();
    this.controllers.set(repoId, controller);
    const job = this.launch(repoId, controller.signal);
    this.starts.set(repoId, job);
    try {
      return await job;
    } finally {
      this.busy.delete(repoId);
      this.controllers.delete(repoId);
      this.starts.delete(repoId);
    }
  }
  private async launch(repoId: string, signal: AbortSignal): Promise<{ url: string }> {
    try {
      const repo = this.store.repo(repoId);
      if (!repo.authorized) throw new Fault('仓库尚未授权本地命令执行', 403);
      if (!repo.commands.start) throw new Fault('请先配置体验启动命令');
      await this.stopChild(repoId);
      await this.freePort(repo.commands.port);
      signal.throwIfAborted();
      this.store.patchRepo(repoId, { preview: { status: 'starting' } });
      const path = await this.workspaces.view(
        repo,
        'preview',
        `refs/remotes/origin/${repo.defaultBranch}`,
      );
      for (const text of [repo.commands.install, repo.commands.build].filter(Boolean)) {
        const result = await shellCommand(text, path, signal);
        if (result.code !== 0) throw new Fault(`体验准备失败：${result.stderr || result.stdout}`);
      }
      signal.throwIfAborted();
      const cmd = repo.commands.start.replaceAll('{port}', String(repo.commands.port));
      const child =
        process.platform === 'win32'
          ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
              cwd: path,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, PORT: String(repo.commands.port) },
            })
          : spawn('/bin/sh', ['-c', cmd], {
              cwd: path,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, PORT: String(repo.commands.port) },
            });
      this.children.set(repoId, child);
      child.stdout?.on('data', (d) =>
        this.store.event('preview', d.toString(), { projectId: repo.projectId }),
      );
      child.stderr?.on('data', (d) =>
        this.store.event('preview', d.toString(), { projectId: repo.projectId }),
      );
      let error: Error | undefined;
      child.on('error', (e) => {
        error = e;
      });
      child.on('exit', (code) => {
        if (this.children.get(repoId) === child) {
          this.children.delete(repoId);
          this.store.patchRepo(repoId, {
            preview: { status: 'failed', error: `体验进程退出 (${code})` },
          });
        }
      });
      const url = `http://127.0.0.1:${repo.commands.port}`;
      for (let i = 0; i < 40; i++) {
        signal.throwIfAborted();
        if (error) throw error;
        if (child.exitCode !== null) throw new Fault(`体验进程退出 (${child.exitCode})`);
        try {
          const r = await fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
          });
          if (r.status < 500) {
            this.store.patchRepo(repoId, { preview: { status: 'running', url, pid: child.pid } });
            return { url };
          }
        } catch {
          /* The process may still be binding its socket; bounded readiness probe. */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Fault('体验服务未在规定时间内通过 HTTP 健康检查');
    } catch (e) {
      await this.stopChild(repoId);
      this.store.patchRepo(repoId, {
        preview: signal.aborted
          ? { status: 'stopped' }
          : { status: 'failed', error: redact(String(e)) },
      });
      throw e;
    }
  }
}
