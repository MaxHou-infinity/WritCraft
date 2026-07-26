(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftGraphLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  function stableHash(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function layoutGraph(nodes, options = {}) {
    const width = Math.max(320, Number(options.width) || 1000);
    const height = Math.max(240, Number(options.height) || 700);
    const issueIds = options.issueIds instanceof Set ? options.issueIds : new Set(options.issueIds || []);
    const prioritySpacing = Math.max(16, Number(options.prioritySpacing) || 28);
    const sorted = [...(nodes || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const priority = sorted.filter(node => node.type === 'time' || issueIds.has(node.id));
    const regular = sorted.filter(node => node.type !== 'time' && !issueIds.has(node.id));
    const result = new Map();
    const columns = Math.max(1, Math.floor((width - 48) / prioritySpacing));
    const priorityRows = Math.ceil(priority.length / columns);
    const priorityWidth = Math.min(columns, Math.max(1, priority.length)) * prioritySpacing;
    const priorityStartX = Math.max(24, (width - priorityWidth) / 2 + prioritySpacing / 2);
    priority.forEach((node, index) => {
      result.set(node.id, {
        x: priorityStartX + index % columns * prioritySpacing,
        y: 28 + Math.floor(index / columns) * prioritySpacing,
      });
    });

    // A Vogel spiral stays deterministic and grows with the input. Unlike the
    // old clamped rings, later nodes keep receiving distinct radii.
    const top = priorityRows ? 42 + priorityRows * prioritySpacing : 28;
    const centerX = width / 2;
    const radialStep = Math.max(18, Number(options.radialStep) || 22);
    const verticalRadius = radialStep * Math.sqrt(regular.length) * .78;
    // Priority nodes occupy the header grid. A large Vogel spiral used to
    // grow back through that grid, so issue/time nodes could overlap regular
    // nodes even though priority-to-priority spacing remained valid. When a
    // priority grid exists, place the spiral far enough below it that its
    // mathematical upper bound clears the grid; layoutBounds() then expands
    // the scene deterministically instead of clamping or overlapping it.
    const centerY = Math.max(
      top + 90,
      (top + height) / 2,
      priorityRows ? top + verticalRadius + 16 : 0
    );
    regular.forEach((node, index) => {
      const radius = radialStep * Math.sqrt(index + 1);
      const angle = (index + 1) * GOLDEN_ANGLE;
      result.set(node.id, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius * .78,
      });
    });
    return result;
  }

  function layoutBounds(positions, options = {}) {
    const padding = Math.max(24, Number(options.padding) || 44);
    const values = [...(positions?.values?.() || [])];
    if (!values.length) return { x: 0, y: 0, width: 1000, height: 700 };
    const xs = values.map(point => point.x);
    const ys = values.map(point => point.y);
    const minX = Math.min(0, ...xs) - padding;
    const minY = Math.min(0, ...ys) - padding;
    const maxX = Math.max(1000, ...xs) + padding;
    const maxY = Math.max(700, ...ys) + padding;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function shouldShowLabel(node, index, total, isPriority = false) {
    if (isPriority || total <= 140) return true;
    const stride = Math.max(2, Math.ceil(total / 110));
    return stableHash(node?.id || index) % stride === 0;
  }

  return { layoutGraph, layoutBounds, shouldShowLabel, stableHash };
});
