const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const BATTERY_SERVICE_UUID = 0x180f;
const BATTERY_LEVEL_UUID = 0x2a19;
const TURN_REPEAT_MS = 120;
const RECONNECT_DELAY_MS = 1600;
const COMPACT_STATUS_MEDIA = '(max-width: 860px)';

const ui = {
  connectButton: document.querySelector('#connectButton'),
  disconnectButton: document.querySelector('#disconnectButton'),
  installButton: document.querySelector('#installButton'),
  unlockButton: document.querySelector('#unlockButton'),
  refreshButton: document.querySelector('#refreshButton'),
  toggleTelemetryButton: document.querySelector('#toggleTelemetryButton'),
  speedSlider: document.querySelector('#speedSlider'),
  speedValue: document.querySelector('#speedValue'),
  connectionState: document.querySelector('#connectionState'),
  reconnectState: document.querySelector('#reconnectState'),
  lockState: document.querySelector('#lockState'),
  batteryValue: document.querySelector('#batteryValue'),
  batteryMvValue: document.querySelector('#batteryMvValue'),
  accelValue: document.querySelector('#accelValue'),
  gyroValue: document.querySelector('#gyroValue'),
  hint: document.querySelector('#hint'),
  dirButtons: Array.from(document.querySelectorAll('.dir-button')),
  presets: Array.from(document.querySelectorAll('.preset')),
  turnLeft: document.querySelector('#turnLeft'),
  turnStop: document.querySelector('#turnStop'),
  turnRight: document.querySelector('#turnRight'),
};

const state = {
  device: null,
  server: null,
  rxChar: null,
  txChar: null,
  batteryChar: null,
  autoReconnect: true,
  reconnectTimer: null,
  turnTimer: null,
  selectedDirection: 0,
  selectedSpeed: Number(ui.speedSlider.value),
  incoming: '',
  installPrompt: null,
  unlocked: false,
  telemetryCollapsed: document.body.classList.contains('telemetry-collapsed'),
};

ui.speedValue.textContent = String(state.selectedSpeed);

function clampSpeed(value) {
  return Math.max(0, Math.min(255, value));
}

function setHint(text) {
  ui.hint.textContent = text;
}

function setConnected(connected) {
  ui.connectionState.textContent = connected ? '已连接' : '未连接';
  ui.connectButton.textContent = connected ? '重新同步' : '连接设备';
}

function updateReconnectState() {
  ui.reconnectState.textContent = state.autoReconnect ? '自动' : '手动停止';
}

function updateLockButton() {
  ui.unlockButton.textContent = state.unlocked ? '发送锁定' : '发送解锁';
  ui.lockState.textContent = state.unlocked ? '已解锁' : '锁定';
}

function updateDirectionButtons() {
  ui.dirButtons.forEach((button) => {
    const active = Number(button.dataset.dir) === state.selectedDirection;
    button.classList.toggle('active', active);
  });
}

function updatePresets() {
  ui.presets.forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.speed) === state.selectedSpeed);
  });
}

function updateSpeed(value) {
  state.selectedSpeed = clampSpeed(value);
  ui.speedSlider.value = String(state.selectedSpeed);
  ui.speedValue.textContent = String(state.selectedSpeed);
  updatePresets();
}

function setTelemetryCollapsed(collapsed) {
  state.telemetryCollapsed = collapsed;
  document.body.classList.toggle('telemetry-collapsed', collapsed);
  ui.toggleTelemetryButton.textContent = collapsed ? '展开' : '收起';
  ui.toggleTelemetryButton.setAttribute('aria-expanded', String(!collapsed));
}

function renderBatteryPercent(percent) {
  if (!Number.isFinite(percent) || percent < 0) {
    ui.batteryValue.textContent = 'N/A';
    return;
  }

  ui.batteryValue.textContent = `${percent}%`;
}

function renderBatteryMv(mv) {
  if (!Number.isFinite(mv) || mv < 0) {
    ui.batteryMvValue.textContent = 'N/A';
    return;
  }

  ui.batteryMvValue.textContent = `${mv} mV`;
}

function updateTelemetry(panel) {
  if (panel.type === 'BAS') {
    renderBatteryPercent(panel.percent);
    return;
  }

  if (panel.type === 'BT') {
    renderBatteryPercent(panel.percent);
    renderBatteryMv(panel.mv);
    return;
  }

  if (panel.type === 'IM') {
    ui.accelValue.textContent = panel.accel < 0 ? 'N/A' : String(panel.accel);
    ui.gyroValue.textContent = panel.gyro < 0 ? 'N/A' : String(panel.gyro);
    return;
  }

  if (panel.type === 'ST') {
    state.unlocked = panel.unlocked === 1;
    state.selectedDirection = panel.flapDir;
    updateSpeed(panel.flapSpeed);
    updateLockButton();
    updateDirectionButtons();
  }
}

function parseLine(line) {
  const parts = line.trim().split(',');

  if (parts[0] === 'ST' && parts.length >= 5) {
    updateTelemetry({
      type: 'ST',
      unlocked: Number(parts[1]),
      flapDir: Number(parts[2]),
      flapSpeed: Number(parts[3]),
      turnDir: Number(parts[4]),
    });
    return;
  }

  if (parts[0] === 'BT' && parts.length >= 3) {
    updateTelemetry({
      type: 'BT',
      percent: Number(parts[1]),
      mv: Number(parts[2]),
    });
    return;
  }

  if (parts[0] === 'IM' && parts.length >= 3) {
    updateTelemetry({
      type: 'IM',
      accel: Number(parts[1]),
      gyro: Number(parts[2]),
    });
  }
}

function onNotification(event) {
  const chunk = new TextDecoder().decode(event.target.value);
  state.incoming += chunk;
  const lines = state.incoming.split('\n');
  state.incoming = lines.pop() ?? '';

  lines.forEach((line) => {
    if (line.trim()) {
      parseLine(line);
    }
  });
}

function onBatteryNotification(event) {
  const percent = event.target.value.getUint8(0);
  updateTelemetry({ type: 'BAS', percent });
}

async function syncBatteryLevel() {
  if (!state.batteryChar) {
    return;
  }

  const value = await state.batteryChar.readValue();
  updateTelemetry({ type: 'BAS', percent: value.getUint8(0) });
}

async function writeCommand(command) {
  if (!state.rxChar) {
    throw new Error('尚未连接控制通道');
  }

  const payload = new TextEncoder().encode(`${command}\n`);
  const { writeWithoutResponse, write } = state.rxChar.properties;

  if (writeWithoutResponse) {
    await state.rxChar.writeValueWithoutResponse(payload);
    return;
  }

  if (write) {
    await state.rxChar.writeValue(payload);
    return;
  }

  throw new Error('设备控制特征不可写');
}

async function syncState() {
  const results = await Promise.allSettled([
    writeCommand('Q'),
    syncBatteryLevel(),
  ]);

  const failed = results.find((result) => result.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
}

async function applyFlapState() {
  const speed = state.selectedDirection === 0 ? 0 : state.selectedSpeed;
  await writeCommand(`F,${state.selectedDirection},${speed}`);
}

function stopTurnLoop(sendStop = true) {
  if (state.turnTimer) {
    window.clearInterval(state.turnTimer);
    state.turnTimer = null;
  }

  ui.turnLeft.classList.remove('active');
  ui.turnRight.classList.remove('active');

  if (sendStop) {
    writeCommand('T,0').catch(() => {});
  }
}

function startTurnLoop(dir) {
  stopTurnLoop(false);
  const activeButton = dir < 0 ? ui.turnLeft : ui.turnRight;
  activeButton.classList.add('active');
  writeCommand(`T,${dir}`).catch(() => {});
  state.turnTimer = window.setInterval(() => {
    writeCommand(`T,${dir}`).catch(() => {});
  }, TURN_REPEAT_MS);
}

function scheduleReconnect() {
  if (!state.autoReconnect || !state.device) {
    return;
  }

  window.clearTimeout(state.reconnectTimer);
  state.reconnectTimer = window.setTimeout(async () => {
    try {
      setHint('设备断开，正在自动重连…');
      await connectGatt(false);
    } catch (error) {
      setHint(`自动重连失败：${error.message}`);
      scheduleReconnect();
    }
  }, RECONNECT_DELAY_MS);
}

function handleDisconnect() {
  setConnected(false);
  stopTurnLoop(false);
  state.server = null;
  state.rxChar = null;
  state.txChar = null;
  state.batteryChar = null;
  setHint(state.autoReconnect ? '连接已断开，等待自动重连。' : '连接已断开。');
  scheduleReconnect();
}

async function connectBatteryService() {
  try {
    const batteryService = await state.server.getPrimaryService(BATTERY_SERVICE_UUID);
    state.batteryChar = await batteryService.getCharacteristic(BATTERY_LEVEL_UUID);
    await state.batteryChar.startNotifications();
    state.batteryChar.removeEventListener('characteristicvaluechanged', onBatteryNotification);
    state.batteryChar.addEventListener('characteristicvaluechanged', onBatteryNotification);
    await syncBatteryLevel();
    return true;
  } catch (error) {
    state.batteryChar = null;
    return false;
  }
}

async function connectGatt(allowPicker = true) {
  if (!navigator.bluetooth) {
    throw new Error('当前浏览器不支持 Web Bluetooth');
  }

  if (!state.device && allowPicker) {
    state.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Morpho' }],
      optionalServices: [NUS_SERVICE_UUID, BATTERY_SERVICE_UUID],
    });
    state.device.addEventListener('gattserverdisconnected', handleDisconnect);
  }

  if (!state.device) {
    throw new Error('未选择蓝牙设备');
  }

  window.clearTimeout(state.reconnectTimer);
  state.server = await state.device.gatt.connect();

  const service = await state.server.getPrimaryService(NUS_SERVICE_UUID);
  state.rxChar = await service.getCharacteristic(NUS_RX_UUID);
  state.txChar = await service.getCharacteristic(NUS_TX_UUID);
  await state.txChar.startNotifications();
  state.txChar.removeEventListener('characteristicvaluechanged', onNotification);
  state.txChar.addEventListener('characteristicvaluechanged', onNotification);

  const batteryReady = await connectBatteryService();
  setConnected(true);
  setHint(
    batteryReady
      ? '连接成功，可以开始控制。'
      : '连接成功，但设备未暴露标准电池服务，将仅显示 NUS 状态回读。',
  );
  await syncState();
}

async function connectOrSync() {
  state.autoReconnect = true;
  updateReconnectState();

  try {
    if (state.server?.connected) {
      await syncState();
      setHint('状态已刷新。');
      return;
    }

    await connectGatt(true);
  } catch (error) {
    setHint(`连接失败：${error.message}`);
  }
}

function stopReconnect() {
  state.autoReconnect = false;
  updateReconnectState();
  window.clearTimeout(state.reconnectTimer);
  stopTurnLoop(false);

  if (state.device?.gatt?.connected) {
    state.device.gatt.disconnect();
  } else {
    setHint('已停止自动重连。');
  }
}

ui.connectButton.addEventListener('click', connectOrSync);
ui.disconnectButton.addEventListener('click', stopReconnect);
ui.refreshButton.addEventListener('click', () => {
  syncState().catch((error) => setHint(`刷新失败：${error.message}`));
});
ui.toggleTelemetryButton.addEventListener('click', () => {
  setTelemetryCollapsed(!state.telemetryCollapsed);
});

ui.unlockButton.addEventListener('click', async () => {
  try {
    await writeCommand(state.unlocked ? 'U0' : 'U1');
    setHint(state.unlocked ? '已发送锁定命令。' : '已发送解锁命令。');
  } catch (error) {
    setHint(`解锁命令失败：${error.message}`);
  }
});

ui.dirButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    state.selectedDirection = Number(button.dataset.dir);
    updateDirectionButtons();

    try {
      await applyFlapState();
    } catch (error) {
      setHint(`扑翼方向命令失败：${error.message}`);
    }
  });
});

ui.speedSlider.addEventListener('input', (event) => {
  updateSpeed(Number(event.target.value));
});

ui.speedSlider.addEventListener('change', async () => {
  try {
    await applyFlapState();
  } catch (error) {
    setHint(`扑翼速度命令失败：${error.message}`);
  }
});

ui.presets.forEach((button) => {
  button.addEventListener('click', async () => {
    updateSpeed(Number(button.dataset.speed));

    try {
      await applyFlapState();
    } catch (error) {
      setHint(`预设速度命令失败：${error.message}`);
    }
  });
});

[
  [ui.turnLeft, -1],
  [ui.turnRight, 1],
].forEach(([button, dir]) => {
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startTurnLoop(dir);
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
    button.addEventListener(eventName, () => stopTurnLoop(true));
  });
});

ui.turnStop.addEventListener('click', () => stopTurnLoop(true));

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  ui.installButton.classList.remove('hidden');
});

ui.installButton.addEventListener('click', async () => {
  if (!state.installPrompt) {
    return;
  }

  await state.installPrompt.prompt();
  state.installPrompt = null;
  ui.installButton.classList.add('hidden');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}

updateReconnectState();
updateLockButton();
updateDirectionButtons();
updatePresets();
setTelemetryCollapsed(window.matchMedia(COMPACT_STATUS_MEDIA).matches);
