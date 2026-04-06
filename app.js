const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const TURN_REPEAT_MS = 120;
const RECONNECT_DELAY_MS = 1600;

const ui = {
  connectButton: document.querySelector('#connectButton'),
  disconnectButton: document.querySelector('#disconnectButton'),
  installButton: document.querySelector('#installButton'),
  unlockButton: document.querySelector('#unlockButton'),
  refreshButton: document.querySelector('#refreshButton'),
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
  autoReconnect: true,
  reconnectTimer: null,
  turnTimer: null,
  selectedDirection: 0,
  selectedSpeed: Number(ui.speedSlider.value),
  incoming: '',
  installPrompt: null,
  unlocked: false,
};

ui.speedValue.textContent = String(state.selectedSpeed);

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
  state.selectedSpeed = value;
  ui.speedSlider.value = String(value);
  ui.speedValue.textContent = String(value);
  updatePresets();
}

function updateTelemetry(panel) {
  if (panel.type === 'BT') {
    if (panel.percent < 0 || panel.mv < 0) {
      ui.batteryValue.textContent = 'N/A';
      ui.batteryMvValue.textContent = 'N/A';
    } else {
      ui.batteryValue.textContent = `${panel.percent}%`;
      ui.batteryMvValue.textContent = `${panel.mv} mV`;
    }
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
  }

  if (parts[0] === 'BT' && parts.length >= 3) {
    updateTelemetry({
      type: 'BT',
      percent: Number(parts[1]),
      mv: Number(parts[2]),
    });
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

async function writeCommand(command) {
  if (!state.rxChar) {
    return;
  }

  const payload = new TextEncoder().encode(`${command}\n`);
  if (typeof state.rxChar.writeValueWithoutResponse === 'function') {
    await state.rxChar.writeValueWithoutResponse(payload);
    return;
  }
  await state.rxChar.writeValue(payload);
}

async function syncState() {
  await writeCommand('Q');
}

async function applyFlapState() {
  await writeCommand(`F,${state.selectedDirection},${state.selectedDirection === 0 ? 0 : state.selectedSpeed}`);
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
  setHint(state.autoReconnect ? '连接已断开，等待自动重连。' : '连接已断开。');
  scheduleReconnect();
}

async function connectGatt(allowPicker = true) {
  if (!navigator.bluetooth) {
    throw new Error('当前浏览器不支持 Web Bluetooth');
  }

  if (!state.device && allowPicker) {
    state.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Morpho' }],
      optionalServices: [NUS_SERVICE_UUID],
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
  setConnected(true);
  setHint('连接成功，可以开始控制。');
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

ui.unlockButton.addEventListener('click', async () => {
  try {
    const next = state.unlocked ? 'U0' : 'U1';
    await writeCommand(next);
    state.unlocked = !state.unlocked;
    updateLockButton();
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
  ['pointerdown'].forEach((eventName) => {
    button.addEventListener(eventName, (event) => {
      event.preventDefault();
      startTurnLoop(dir);
    });
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
