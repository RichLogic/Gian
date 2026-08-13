(() => {
  'use strict';

  const api = window.gianScreenshotOverlay;
  const canvas = document.getElementById('capture-canvas');
  const context = canvas.getContext('2d', { alpha: false });
  const toolbar = document.getElementById('toolbar');
  const targetLabel = document.getElementById('target-label');
  const selectionSize = document.getElementById('selection-size');
  const status = document.getElementById('capture-status');
  const undoButton = document.getElementById('undo-button');
  const cancelButton = document.getElementById('cancel-button');
  const completeButton = document.getElementById('complete-button');
  const customColor = document.getElementById('custom-color');
  const textEditor = document.getElementById('text-editor');

  const image = new Image();
  let capture = null;
  let selection = null;
  let drag = null;
  let activeAction = null;
  let actions = [];
  let tool = 'cursor';
  let color = '#ff4d4f';
  let lineWidthCss = 2;
  let claimed = false;
  let claimPending = false;
  let completing = false;
  let textPoint = null;
  let mosaicSource = null;
  const pointersDown = new Set();

  const HANDLE_NAMES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  function scaleX() {
    return canvas.width / Math.max(1, window.innerWidth);
  }

  function scaleY() {
    return canvas.height / Math.max(1, window.innerHeight);
  }

  function scaleAverage() {
    return (scaleX() + scaleY()) / 2;
  }

  function imagePoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) * canvas.width / bounds.width, 0, canvas.width),
      y: clamp((event.clientY - bounds.top) * canvas.height / bounds.height, 0, canvas.height),
    };
  }

  function cssPoint(point) {
    return { x: point.x / scaleX(), y: point.y / scaleY() };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizedRect(start, end) {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    return {
      x,
      y,
      width: Math.max(0, Math.max(start.x, end.x) - x),
      height: Math.max(0, Math.max(start.y, end.y) - y),
    };
  }

  function pointInRect(point, rect) {
    return point.x >= rect.x && point.x <= rect.x + rect.width
      && point.y >= rect.y && point.y <= rect.y + rect.height;
  }

  function clampToSelection(point) {
    return {
      x: clamp(point.x, selection.x, selection.x + selection.width),
      y: clamp(point.y, selection.y, selection.y + selection.height),
    };
  }

  function displayStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function setTool(nextTool) {
    commitText();
    tool = nextTool;
    document.querySelectorAll('[data-tool]').forEach(button => {
      button.classList.toggle('active', button.dataset.tool === nextTool);
    });
    canvas.style.cursor = nextTool === 'cursor' ? 'default' : 'crosshair';
  }

  function annotationStyle(action, ctx) {
    ctx.strokeStyle = action.color;
    ctx.fillStyle = action.color;
    ctx.lineWidth = action.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function buildMosaicSource() {
    const block = Math.max(8, Math.round(10 * scaleAverage()));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.ceil(image.naturalWidth / block));
    small.height = Math.max(1, Math.ceil(image.naturalHeight / block));
    const smallContext = small.getContext('2d');
    smallContext.imageSmoothingEnabled = true;
    smallContext.drawImage(image, 0, 0, small.width, small.height);
    return { canvas: small, block };
  }

  function drawMosaic(action, ctx) {
    if (!mosaicSource || action.points.length === 0) return;
    const pattern = ctx.createPattern(mosaicSource.canvas, 'no-repeat');
    if (!pattern) return;
    if (typeof pattern.setTransform === 'function') {
      pattern.setTransform(new DOMMatrix().scale(mosaicSource.block, mosaicSource.block));
    }
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.strokeStyle = pattern;
    ctx.lineWidth = Math.max(action.width * 5, 18 * scaleAverage());
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(action.points[0].x, action.points[0].y);
    for (let index = 1; index < action.points.length; index += 1) {
      ctx.lineTo(action.points[index].x, action.points[index].y);
    }
    if (action.points.length === 1) {
      ctx.lineTo(action.points[0].x + 0.01, action.points[0].y + 0.01);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawAction(action, ctx) {
    if (!action) return;
    if (action.kind === 'mosaic') {
      drawMosaic(action, ctx);
      return;
    }
    annotationStyle(action, ctx);
    if (action.kind === 'rect') {
      const rect = normalizedRect(action.start, action.end);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      return;
    }
    if (action.kind === 'ellipse') {
      const rect = normalizedRect(action.start, action.end);
      ctx.beginPath();
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      return;
    }
    if (action.kind === 'line' || action.kind === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(action.start.x, action.start.y);
      ctx.lineTo(action.end.x, action.end.y);
      ctx.stroke();
      if (action.kind === 'arrow') {
        const angle = Math.atan2(action.end.y - action.start.y, action.end.x - action.start.x);
        const length = Math.max(11 * scaleAverage(), action.width * 4.5);
        ctx.beginPath();
        ctx.moveTo(action.end.x, action.end.y);
        ctx.lineTo(
          action.end.x - length * Math.cos(angle - Math.PI / 7),
          action.end.y - length * Math.sin(angle - Math.PI / 7),
        );
        ctx.moveTo(action.end.x, action.end.y);
        ctx.lineTo(
          action.end.x - length * Math.cos(angle + Math.PI / 7),
          action.end.y - length * Math.sin(angle + Math.PI / 7),
        );
        ctx.stroke();
      }
      return;
    }
    if (action.kind === 'pen') {
      if (action.points.length === 0) return;
      ctx.beginPath();
      ctx.moveTo(action.points[0].x, action.points[0].y);
      for (let index = 1; index < action.points.length; index += 1) {
        const current = action.points[index];
        const previous = action.points[index - 1];
        const midpoint = { x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2 };
        ctx.quadraticCurveTo(previous.x, previous.y, midpoint.x, midpoint.y);
      }
      if (action.points.length === 1) {
        ctx.lineTo(action.points[0].x + 0.01, action.points[0].y + 0.01);
      }
      ctx.stroke();
      return;
    }
    if (action.kind === 'text') {
      ctx.font = `600 ${action.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'top';
      const lineHeight = action.fontSize * 1.35;
      action.text.split('\n').forEach((line, index) => {
        ctx.fillText(line, action.point.x, action.point.y + lineHeight * index);
      });
    }
  }

  function drawAnnotations(ctx) {
    if (!selection) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(selection.x, selection.y, selection.width, selection.height);
    ctx.clip();
    for (const action of actions) drawAction(action, ctx);
    drawAction(activeAction, ctx);
    ctx.restore();
  }

  function handlePoints(rect) {
    const left = rect.x;
    const centerX = rect.x + rect.width / 2;
    const right = rect.x + rect.width;
    const top = rect.y;
    const centerY = rect.y + rect.height / 2;
    const bottom = rect.y + rect.height;
    return [
      { x: left, y: top }, { x: centerX, y: top }, { x: right, y: top },
      { x: right, y: centerY }, { x: right, y: bottom }, { x: centerX, y: bottom },
      { x: left, y: bottom }, { x: left, y: centerY },
    ];
  }

  function drawSelection(ctx) {
    if (!selection) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(selection.x, selection.y, selection.width, selection.height);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#2f9bff';
    ctx.lineWidth = Math.max(1, scaleAverage());
    ctx.strokeRect(selection.x, selection.y, selection.width, selection.height);
    const radius = 3.5 * scaleAverage();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1689f5';
    ctx.lineWidth = Math.max(1, scaleAverage());
    for (const point of handlePoints(selection)) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function render() {
    if (!image.complete || !image.naturalWidth) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = true;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawAnnotations(context);
    drawSelection(context);
    updateFloatingUi();
  }

  function updateFloatingUi() {
    if (!selection || selection.width < 1 || selection.height < 1) {
      toolbar.hidden = true;
      selectionSize.hidden = true;
      return;
    }
    toolbar.hidden = false;
    selectionSize.hidden = false;
    selectionSize.textContent = `${Math.round(selection.width)} × ${Math.round(selection.height)}`;

    const topLeft = cssPoint({ x: selection.x, y: selection.y });
    const bottomRight = cssPoint({
      x: selection.x + selection.width,
      y: selection.y + selection.height,
    });
    const toolbarWidth = toolbar.offsetWidth;
    const toolbarHeight = toolbar.offsetHeight;
    const preferredX = bottomRight.x - toolbarWidth;
    const left = clamp(preferredX, 8, window.innerWidth - toolbarWidth - 8);
    const below = bottomRight.y + 10;
    const top = below + toolbarHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, topLeft.y - toolbarHeight - 10);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;

    const sizeWidth = selectionSize.offsetWidth;
    selectionSize.style.left = `${clamp(topLeft.x, 6, window.innerWidth - sizeWidth - 6)}px`;
    selectionSize.style.top = `${clamp(topLeft.y - 25, 6, window.innerHeight - 24)}px`;
    undoButton.disabled = actions.length === 0;
  }

  function handleAt(point) {
    if (!selection) return null;
    const radius = 9 * scaleAverage();
    const handles = handlePoints(selection);
    for (let index = 0; index < handles.length; index += 1) {
      const handle = handles[index];
      if (Math.hypot(point.x - handle.x, point.y - handle.y) <= radius) {
        return HANDLE_NAMES[index];
      }
    }
    return null;
  }

  function beginSelection(point) {
    commitText();
    actions = [];
    activeAction = null;
    selection = { x: point.x, y: point.y, width: 0, height: 0 };
    drag = { kind: 'new-selection', start: point };
    setTool('cursor');
  }

  function beginPointerAction(point) {
    if (!selection) {
      beginSelection(point);
      return;
    }
    if (tool === 'cursor') {
      const handle = handleAt(point);
      if (handle) {
        drag = { kind: 'resize-selection', handle, start: point, original: { ...selection } };
      } else if (pointInRect(point, selection)) {
        drag = { kind: 'move-selection', start: point, original: { ...selection } };
      } else {
        beginSelection(point);
      }
      return;
    }
    if (!pointInRect(point, selection)) return;
    const clamped = clampToSelection(point);
    if (tool === 'text') {
      openTextEditor(clamped);
      return;
    }
    if (tool === 'pen' || tool === 'mosaic') {
      activeAction = {
        kind: tool,
        points: [clamped],
        color,
        width: lineWidthCss * scaleAverage(),
      };
    } else {
      activeAction = {
        kind: tool,
        start: clamped,
        end: clamped,
        color,
        width: lineWidthCss * scaleAverage(),
      };
    }
    drag = { kind: 'annotation' };
  }

  function resizeSelection(point) {
    const { original, handle } = drag;
    let left = original.x;
    let top = original.y;
    let right = original.x + original.width;
    let bottom = original.y + original.height;
    if (handle.includes('w')) left = point.x;
    if (handle.includes('e')) right = point.x;
    if (handle.includes('n')) top = point.y;
    if (handle.includes('s')) bottom = point.y;
    const minSize = 5 * scaleAverage();
    if (right - left < minSize) {
      if (handle.includes('w')) left = right - minSize;
      else right = left + minSize;
    }
    if (bottom - top < minSize) {
      if (handle.includes('n')) top = bottom - minSize;
      else bottom = top + minSize;
    }
    selection = {
      x: clamp(left, 0, canvas.width - minSize),
      y: clamp(top, 0, canvas.height - minSize),
      width: clamp(right - left, minSize, canvas.width),
      height: clamp(bottom - top, minSize, canvas.height),
    };
    selection.width = Math.min(selection.width, canvas.width - selection.x);
    selection.height = Math.min(selection.height, canvas.height - selection.y);
  }

  function updateDrag(point) {
    if (!drag) return;
    if (drag.kind === 'new-selection') {
      selection = normalizedRect(drag.start, point);
    } else if (drag.kind === 'move-selection') {
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      selection = {
        ...drag.original,
        x: clamp(drag.original.x + dx, 0, canvas.width - drag.original.width),
        y: clamp(drag.original.y + dy, 0, canvas.height - drag.original.height),
      };
    } else if (drag.kind === 'resize-selection') {
      resizeSelection(point);
    } else if (drag.kind === 'annotation' && activeAction) {
      const clamped = clampToSelection(point);
      if (activeAction.points) {
        const last = activeAction.points[activeAction.points.length - 1];
        if (Math.hypot(clamped.x - last.x, clamped.y - last.y) >= scaleAverage()) {
          activeAction.points.push(clamped);
        }
      } else {
        activeAction.end = clamped;
      }
    }
    render();
  }

  function finishDrag() {
    if (!drag) return;
    if (drag.kind === 'new-selection' && selection) {
      const minSize = 3 * scaleAverage();
      if (selection.width < minSize || selection.height < minSize) selection = null;
    } else if (drag.kind === 'annotation' && activeAction) {
      const useful = activeAction.points
        ? activeAction.points.length > 0
        : Math.hypot(
            activeAction.end.x - activeAction.start.x,
            activeAction.end.y - activeAction.start.y,
          ) > scaleAverage();
      if (useful) actions.push(activeAction);
      activeAction = null;
    }
    drag = null;
    render();
  }

  function openTextEditor(point) {
    commitText();
    textPoint = point;
    const css = cssPoint(point);
    const selectionRight = (selection.x + selection.width) / scaleX();
    textEditor.value = '';
    textEditor.style.left = `${css.x}px`;
    textEditor.style.top = `${css.y}px`;
    textEditor.style.width = `${Math.max(80, Math.min(320, selectionRight - css.x))}px`;
    textEditor.style.setProperty('--text-color', color);
    textEditor.hidden = false;
    requestAnimationFrame(() => textEditor.focus());
  }

  function autosizeTextEditor() {
    textEditor.style.height = 'auto';
    textEditor.style.height = `${Math.min(220, Math.max(34, textEditor.scrollHeight + 2))}px`;
  }

  function commitText() {
    if (textEditor.hidden || !textPoint) return;
    const value = textEditor.value.trim();
    if (value) {
      actions.push({
        kind: 'text',
        point: textPoint,
        text: value,
        color,
        width: lineWidthCss * scaleAverage(),
        fontSize: Math.max(16, (15 + lineWidthCss) * scaleAverage()),
      });
    }
    textEditor.hidden = true;
    textEditor.value = '';
    textPoint = null;
    render();
  }

  function cancelText() {
    textEditor.hidden = true;
    textEditor.value = '';
    textPoint = null;
    render();
  }

  function drawExport(outputContext) {
    outputContext.imageSmoothingEnabled = true;
    outputContext.drawImage(
      image,
      selection.x,
      selection.y,
      selection.width,
      selection.height,
      0,
      0,
      selection.width,
      selection.height,
    );
    outputContext.save();
    outputContext.translate(-selection.x, -selection.y);
    outputContext.beginPath();
    outputContext.rect(selection.x, selection.y, selection.width, selection.height);
    outputContext.clip();
    for (const action of actions) drawAction(action, outputContext);
    outputContext.restore();
  }

  async function completeCapture() {
    commitText();
    if (!capture || !selection || completing) return;
    completing = true;
    completeButton.disabled = true;
    displayStatus('正在生成截图…');
    try {
      const output = document.createElement('canvas');
      output.width = Math.max(1, Math.round(selection.width));
      output.height = Math.max(1, Math.round(selection.height));
      const outputContext = output.getContext('2d', { alpha: false });
      drawExport(outputContext);
      const blob = await new Promise((resolve, reject) => {
        output.toBlob(value => value ? resolve(value) : reject(new Error('PNG encode failed')), 'image/png');
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const accepted = await api.complete(capture.captureId, bytes);
      if (!accepted) throw new Error('Screenshot was not accepted');
    } catch {
      completing = false;
      completeButton.disabled = false;
      displayStatus('截图生成失败，请缩小选区后重试');
      window.setTimeout(() => displayStatus(''), 2600);
    }
  }

  async function cancelCapture() {
    if (completing) return;
    try {
      await api.cancel();
    } catch {
      displayStatus('无法退出截图，请按 Esc 重试');
    }
  }

  async function claimAndBegin(event) {
    if (!capture || completing || event.button !== 0) return;
    if (textEditor === event.target) return;
    const point = imagePoint(event);
    if (!claimed) {
      if (claimPending) return;
      claimPending = true;
      let accepted = false;
      try {
        accepted = await api.claim(capture.captureId);
      } finally {
        claimPending = false;
      }
      if (!accepted) {
        displayStatus('请在开始框选的屏幕继续操作');
        return;
      }
      claimed = true;
      displayStatus('');
    }
    // The IPC claim can outlive a very short click. Do not start a drag after
    // its matching pointerup has already arrived.
    if (!pointersDown.has(event.pointerId)) return;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
    beginPointerAction(point);
    render();
  }

  canvas.addEventListener('pointerdown', event => {
    pointersDown.add(event.pointerId);
    void claimAndBegin(event);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) {
      if (tool === 'cursor' && selection) {
        const point = imagePoint(event);
        const handle = handleAt(point);
        canvas.style.cursor = handle
          ? `${handle}-resize`
          : pointInRect(point, selection) ? 'move' : 'crosshair';
      }
      return;
    }
    updateDrag(imagePoint(event));
  });
  canvas.addEventListener('pointerup', event => {
    pointersDown.delete(event.pointerId);
    finishDrag();
  });
  canvas.addEventListener('pointercancel', event => {
    pointersDown.delete(event.pointerId);
    finishDrag();
  });
  canvas.addEventListener('contextmenu', event => event.preventDefault());

  document.querySelectorAll('[data-tool]').forEach(button => {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  });
  document.querySelectorAll('[data-color]').forEach(button => {
    button.addEventListener('click', () => {
      color = button.dataset.color;
      customColor.value = color;
      document.querySelectorAll('.color-swatch, .custom-color').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
    });
  });
  customColor.addEventListener('input', event => {
    color = event.target.value;
    document.querySelectorAll('.color-swatch, .custom-color').forEach(item => item.classList.remove('active'));
    customColor.closest('.custom-color').classList.add('active');
    textEditor.style.setProperty('--text-color', color);
  });
  document.querySelectorAll('[data-width]').forEach(button => {
    button.addEventListener('click', () => {
      lineWidthCss = Number(button.dataset.width);
      document.querySelectorAll('[data-width]').forEach(item => item.classList.toggle('active', item === button));
    });
  });

  undoButton.addEventListener('click', () => {
    commitText();
    actions.pop();
    render();
  });
  cancelButton.addEventListener('click', () => { void cancelCapture(); });
  completeButton.addEventListener('click', () => { void completeCapture(); });
  textEditor.addEventListener('input', autosizeTextEditor);
  textEditor.addEventListener('blur', commitText);
  textEditor.addEventListener('pointerdown', event => event.stopPropagation());
  textEditor.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelText();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitText();
    }
  });

  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      commitText();
      actions.pop();
      render();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!textEditor.hidden) cancelText();
      else void cancelCapture();
      return;
    }
    if (event.key === 'Enter' && textEditor.hidden) {
      event.preventDefault();
      void completeCapture();
      return;
    }
    if (textEditor.hidden && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const shortcuts = { v: 'cursor', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', p: 'pen', t: 'text', m: 'mosaic' };
      const next = shortcuts[event.key.toLowerCase()];
      if (next) setTool(next);
    }
  });

  window.addEventListener('resize', render);
  window.addEventListener('dragstart', event => event.preventDefault());

  async function initialize() {
    if (!api || !context) {
      displayStatus('截图组件初始化失败');
      return;
    }
    try {
      capture = await api.getCapture();
      if (!capture) throw new Error('No active capture');
      targetLabel.textContent = `完成后加入：${capture.targetLabel}`;
      image.src = capture.imageDataUrl;
      await image.decode();
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      mosaicSource = buildMosaicSource();
      render();
    } catch {
      displayStatus('无法载入屏幕画面，按 Esc 退出');
    }
  }

  void initialize();
})();
