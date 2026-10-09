import { WORLD_W, WORLD_H, MAX_ENEMIES, MAX_TOWERS, TOWERS } from './data.js';
import { COMPUTE, RENDER, GW, GH, GRID_CAP, ENEMY_STRIDE, TCFG_STRIDE, TSTATE_STRIDE, PARAM_FLOATS } from './shaders.js';

const MAX_STEPS = 8;

export async function createGpu(canvas, map) {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was found.');
  const device = await adapter.requestDevice();
  device.lost.then((info) => console.error('GPU device lost:', info.message));
  const format = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas.getContext('webgpu');
  ctx.configure({ device, format, alphaMode: 'premultiplied' });

  const S = GPUBufferUsage;
  const mk = (size, usage, label) => device.createBuffer({ size, usage, label });
  const align = device.limits.minUniformBufferOffsetAlignment;
  const slot = Math.ceil((PARAM_FLOATS * 4) / align) * align;

  const enemyBytes = MAX_ENEMIES * ENEMY_STRIDE;
  const enemies = [0, 1].map((n) => mk(enemyBytes, S.STORAGE | S.COPY_DST | S.COPY_SRC, 'enemies' + n));
  const fieldBuf = mk(map.field.byteLength, S.STORAGE | S.COPY_DST, 'field');
  device.queue.writeBuffer(fieldBuf, 0, map.field);
  const gridBuf = mk((GW * GH + GW * GH * GRID_CAP) * 4, S.STORAGE, 'grid');
  const tcfg = mk(MAX_TOWERS * TCFG_STRIDE, S.STORAGE | S.COPY_DST, 'tcfg');
  const tstate = mk(MAX_TOWERS * TSTATE_STRIDE, S.STORAGE | S.COPY_DST | S.COPY_SRC, 'tstate');
  const counters = mk(16, S.STORAGE | S.COPY_DST | S.COPY_SRC, 'counters');
  const staging = mk(16, S.MAP_READ | S.COPY_DST, 'staging');
  const params = mk(slot * MAX_STEPS, S.UNIFORM | S.COPY_DST, 'params');
  const view = mk(16, S.UNIFORM | S.COPY_DST, 'view');

  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const cBG = [0, 1].map((n) => device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: params, size: PARAM_FLOATS * 4 } },
      { binding: 1, resource: { buffer: enemies[n] } },
      { binding: 2, resource: { buffer: enemies[1 - n] } },
      { binding: 3, resource: { buffer: fieldBuf } },
      { binding: 4, resource: { buffer: gridBuf } },
      { binding: 5, resource: { buffer: tcfg } },
      { binding: 6, resource: { buffer: tstate } },
      { binding: 7, resource: { buffer: counters } },
    ],
  }));
  const checked = async (module) => {
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter((m) => m.type === 'error');
    if (errs.length) throw new Error(`Shader error (${module.label}) line ${errs[0].lineNum}: ${errs[0].message}`);
    return module;
  };
  const cModule = await checked(device.createShaderModule({ code: COMPUTE, label: 'sim' }));
  const cLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipe = (entryPoint) => device.createComputePipeline({ layout: cLayout, compute: { module: cModule, entryPoint } });
  const pClear = pipe('clearGrid'), pBuild = pipe('buildGrid'), pTowers = pipe('towers'), pEnemies = pipe('enemies');

  const rModule = await checked(device.createShaderModule({ code: RENDER, label: 'render' }));
  const rBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ],
  });
  const rLayout = device.createPipelineLayout({ bindGroupLayouts: [rBGL] });
  const blend = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  const rpipe = (vs, fs) => device.createRenderPipeline({
    layout: rLayout,
    vertex: { module: rModule, entryPoint: vs },
    fragment: { module: rModule, entryPoint: fs, targets: [{ format, blend }] },
    primitive: { topology: 'triangle-list' },
  });
  const pEnemyR = rpipe('vsEnemy', 'fsEnemy'), pFxR = rpipe('vsFx', 'fsFx'), pTowerR = rpipe('vsTower', 'fsTower');
  const rBG = [0, 1].map((n) => device.createBindGroup({
    layout: rBGL,
    entries: [
      { binding: 0, resource: { buffer: view } },
      { binding: 1, resource: { buffer: enemies[n] } },
      { binding: 2, resource: { buffer: tcfg } },
      { binding: 3, resource: { buffer: tstate } },
    ],
  }));

  // CPU-side staging for uniforms and tower tables
  const pBuf = new ArrayBuffer(slot * MAX_STEPS);
  const pF = new Float32Array(pBuf), pU = new Uint32Array(pBuf);
  const tcBuf = new ArrayBuffer(MAX_TOWERS * TCFG_STRIDE);
  const tcF = new Float32Array(tcBuf), tcU = new Uint32Array(tcBuf);
  const viewArr = new Float32Array(4);

  let cur = 0;           // which enemy buffer holds the latest state
  let epoch = 0;
  let mapping = false;
  let lastCounters = { kills: 0, gold: 0, leaks: 0, alive: 0 };

  const api = {
    device, adapter,
    get alive() { return lastCounters.alive; },
    reset() {
      epoch++;
      cur = 0;
      const zeroE = new Uint8Array(enemyBytes);
      device.queue.writeBuffer(enemies[0], 0, zeroE);
      device.queue.writeBuffer(enemies[1], 0, zeroE);
      device.queue.writeBuffer(tcfg, 0, new Uint8Array(MAX_TOWERS * TCFG_STRIDE));
      device.queue.writeBuffer(tstate, 0, new Uint8Array(MAX_TOWERS * TSTATE_STRIDE));
      device.queue.writeBuffer(counters, 0, new Uint32Array(4));
      tcU.fill(0);
      lastCounters = { kills: 0, gold: 0, leaks: 0, alive: 0 };
    },
    // towers: array of {kind, level, x, y, active}; stats are looked up in data.js
    uploadTowers(list, resetSlots = []) {
      tcU.fill(0);
      list.forEach((t, i) => {
        if (!t) return;
        const d = TOWERS[t.kind], o = i * (TCFG_STRIDE / 4);
        tcF[o] = t.x; tcF[o + 1] = t.y;
        tcU[o + 2] = t.kind; tcU[o + 3] = t.level;
        tcF[o + 4] = d.range[t.level]; tcF[o + 5] = d.dmg[t.level];
        tcF[o + 6] = d.rate[t.level]; tcF[o + 7] = d.radius[t.level];
        tcU[o + 8] = 1;
      });
      device.queue.writeBuffer(tcfg, 0, tcBuf);
      for (const i of resetSlots) device.queue.writeBuffer(tstate, i * TSTATE_STRIDE, new Uint8Array(TSTATE_STRIDE));
    },
    // steps: [{dt, time, spawnStart, numTowers, hpScale, goldMult, spawnY0, spawnY1, maxUsed, frame, counts:[c1..c4]}]
    frame(steps, viewState) {
      const n = Math.min(steps.length, MAX_STEPS);
      const enc = device.createCommandEncoder();
      for (let s = 0; s < n; s++) {
        const p = steps[s], o = (s * slot) / 4;
        pF[o] = p.dt; pF[o + 1] = p.time; pU[o + 2] = p.spawnStart; pU[o + 3] = p.numTowers;
        pF[o + 4] = p.hpScale; pF[o + 5] = p.goldMult; pF[o + 6] = p.spawnY0; pF[o + 7] = p.spawnY1;
        pU[o + 8] = p.maxUsed; pU[o + 9] = p.frame;
        pU[o + 10] = p.counts[0]; pU[o + 11] = p.counts[1]; pU[o + 12] = p.counts[2]; pU[o + 13] = p.counts[3];
      }
      if (n) device.queue.writeBuffer(params, 0, pBuf, 0, n * slot);
      const pass = enc.beginComputePass();
      for (let s = 0; s < n; s++) {
        const off = s * slot;
        pass.setBindGroup(0, cBG[cur], [off]);
        pass.setPipeline(pClear); pass.dispatchWorkgroups(Math.ceil((GW * GH) / 64));
        pass.setPipeline(pBuild); pass.dispatchWorkgroups(MAX_ENEMIES / 64);
        pass.setPipeline(pTowers); pass.dispatchWorkgroups(1);
        pass.setPipeline(pEnemies); pass.dispatchWorkgroups(MAX_ENEMIES / 64);
        cur = 1 - cur;
      }
      pass.end();

      viewArr[0] = 2 / WORLD_W; viewArr[1] = 2 / WORLD_H;
      viewArr[2] = WORLD_W / canvas.width; viewArr[3] = viewState.time;
      device.queue.writeBuffer(view, 0, viewArr);
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      rp.setBindGroup(0, rBG[cur]);
      rp.setPipeline(pEnemyR); rp.draw(6, MAX_ENEMIES);
      rp.setPipeline(pFxR); rp.draw(6, MAX_TOWERS);
      rp.setPipeline(pTowerR); rp.draw(6, MAX_TOWERS);
      rp.end();

      const readNow = !mapping;
      if (readNow) enc.copyBufferToBuffer(counters, 0, staging, 0, 16);
      device.queue.submit([enc.finish()]);
      if (readNow) {
        mapping = true;
        const e = epoch;
        staging.mapAsync(GPUMapMode.READ).then(() => {
          const v = new Uint32Array(staging.getMappedRange().slice(0));
          staging.unmap();
          mapping = false;
          if (e === epoch) lastCounters = { kills: v[0], gold: v[1] / 16, leaks: v[2], alive: v[3] };
        }).catch(() => { mapping = false; });
      }
    },
    // debugging aid: copy the live enemy and tower state back to the CPU
    async debugRead() {
      const size = enemyBytes + MAX_TOWERS * TSTATE_STRIDE;
      const buf = mk(size, S.MAP_READ | S.COPY_DST, 'debug');
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(enemies[cur], 0, buf, 0, enemyBytes);
      enc.copyBufferToBuffer(tstate, 0, buf, enemyBytes, MAX_TOWERS * TSTATE_STRIDE);
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const data = buf.getMappedRange().slice(0);
      buf.unmap(); buf.destroy();
      return { enemies: new Float32Array(data, 0, enemyBytes / 4), enemiesU: new Uint32Array(data, 0, enemyBytes / 4), towers: new Float32Array(data, enemyBytes), towersU: new Uint32Array(data, enemyBytes) };
    },
    // cumulative totals as last read back from the GPU
    get counters() { return lastCounters; },
  };
  return api;
}
