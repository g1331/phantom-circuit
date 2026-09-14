import { spawn } from 'node:child_process';
import { Codex } from '../src/server/codex.ts';

/** External app-server adapter: setup verifies configuration without making model requests. */
export function profileProtocol(scenario?: { runtimeError: string }) {
  let exited: Promise<void> | undefined;
  class Protocol extends Codex {
    override async stop() {
      if (exited) {
        await this.request('fixture/exit');
        await exited;
      }
      await super.stop();
    }
  }
  return new Protocol((_binary, args, options) => {
    const provider = JSON.parse(
      args
        .find((a) => a.startsWith('model_provider='))!
        .split('=')
        .slice(1)
        .join('='),
    );
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const send = value => console.log(JSON.stringify(value));
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const m = JSON.parse(line);
        if (m.id === undefined) return;
        let result = {};
        if (m.method === 'model/list') result = {data: ['gpt-5.6-luna','gpt-6-astra'].map(model => ({id:model,model,displayName:model,supportedReasoningEfforts:['low','medium','max'].map(reasoningEffort => ({reasoningEffort}))}))};
        if (m.method === 'thread/start') {
          if (m.params.sandbox !== 'read-only' || m.params.approvalPolicy !== 'never') throw Error('Unsafe validation');
          result = {thread:{id:'preflight'},model:m.params.model,modelProvider:m.params.model === 'wrong-provider' ? 'wrong' : process.argv[1],reasoningEffort:m.params.config.model_reasoning_effort === 'unknown' ? 'low' : m.params.config.model_reasoning_effort};
        }
        if (m.method === 'turn/start') {
          if (!process.argv[2]) throw Error('Preflight must not run a turn');
          send({id:m.id,error:{message:process.argv[2]}});
          return;
        }
        send({id:m.id,result});
        if (m.method === 'fixture/exit') setImmediate(() => process.exit(0));
      });
    `,
        provider,
        scenario?.runtimeError ?? '',
      ],
      options,
    );
    exited = new Promise((resolve) => child.on('close', () => resolve()));
    return child;
  });
}
