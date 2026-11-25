// Tool calls inside a reply (Phase 13): one step per call, and the collapsible
// "working" group that holds the narration and steps above the final answer.
// Used by chat.js, which owns the reply model ({segments, steps, finished, ...}).
(function (app) {
  const { el } = app.dom;

  // A tool call inside a reply (Phase 13): "Used `name` input", expandable to the
  // input and result when there are any. step.open survives re-renders.
  const STEP_VERB = { running: 'Running', success: 'Used', error: 'Failed', stopped: 'Stopped' };

  function toolStep(step) {
    const expandable = Boolean(step.input || step.result);
    const box = el(expandable ? 'details' : 'div', 'tool-step');
    box.dataset.status = step.status;
    const head = el(expandable ? 'summary' : 'div', 'tool-head');
    head.append(el('span', 'tool-icon'), el('span', 'tool-verb', STEP_VERB[step.status] || 'Used'),
      el('code', 'tool-name', step.name || 'tool'));
    if (step.input) head.appendChild(el('span', 'tool-input', step.input));
    box.appendChild(head);
    if (expandable) {
      box.open = Boolean(step.open);
      box.addEventListener('toggle', () => { step.open = box.open; });
      if (step.input) box.append(el('div', 'tool-label', 'Input'), el('pre', 'tool-pre', step.input));
      if (step.result) box.append(el('div', 'tool-label', step.status === 'error' ? 'Error' : 'Result'), el('pre', 'tool-pre', step.result));
    }
    return box;
  }

  // "Working... (2 tools so far)" while the agent works; "Used 3 tools · 1 failed" after
  function workSummary(reply) {
    const steps = [...reply.steps.values()];
    const count = `${steps.length} tool${steps.length === 1 ? '' : 's'}`;
    if (!reply.finished) return `Working... (${count} so far)`;
    const failed = steps.filter((s) => s.status === 'error').length;
    const stopped = steps.filter((s) => s.status === 'stopped').length;
    return [`Used ${count}`, failed && `${failed} failed`, stopped && `${stopped} stopped`].filter(Boolean).join(' · ');
  }

  // The collapsible "working" group: open while the agent works, folded when the
  // reply is done (unless the user opened or closed it themselves)
  function workGroup(reply, content) {
    const group = el('details', 'work-group');
    group.dataset.state = reply.finished ? 'done' : 'working';
    const head = el('summary', 'work-head');
    head.append(el('span', 'work-icon'), el('span', 'work-summary', workSummary(reply)));
    group.append(head, el('div', 'work-body'));
    group.lastChild.appendChild(content);
    group.open = reply.workOpen;
    group.addEventListener('toggle', () => {
      // Setting .open while rendering also fires "toggle"; only the user's changes count
      if (group.open !== reply.workOpen) {
        reply.workOpen = group.open;
        reply.workToggled = true;
      }
    });
    return group;
  }

  app.steps = { toolStep, workGroup };
})(window.AgentCore);
