export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(result) {
  if (result.command === 'image jobs list' || result.command === 'image jobs cleanup') {
    writeJobsText(result, 'image');
    return;
  }
  if (result.command?.startsWith('image ')) {
    writeImageText(result);
    return;
  }
  if (result.command === 'chat jobs list' || result.command === 'chat jobs cleanup') {
    writeJobsText(result, 'chat');
    return;
  }
  if (result.command?.startsWith('chat ')) {
    writeChatText(result);
    return;
  }
  if (result.command === 'discover') {
    writeDiscoverText(result);
    return;
  }
  if (result.command?.startsWith('browser ')) {
    writeBrowserText(result);
    return;
  }

  const lines = [];
  lines.push(`status: ${result.ready ? 'ready' : 'not ready'}`);
  lines.push(`cdp: ${result.browser.cdp_available ? result.browser.selected_endpoint : 'unavailable'}`);
  lines.push(`openai pages: ${result.openai.page_count}`);
  if (result.diagnostics.length > 0) {
    lines.push('diagnostics:');
    for (const diagnostic of result.diagnostics) {
      lines.push(`- ${diagnostic.category}: ${diagnostic.message}`);
    }
  }
  lines.push(`next: ${result.next_step}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function writeJobsText(result, label) {
  const lines = [];
  if (result.command === `${label} jobs cleanup`) {
    lines.push(`cleanup: ${result.dry_run ? 'dry-run' : 'deleted'}`);
    lines.push(`candidates: ${result.count}`);
    if (result.deleted?.length > 0) {
      lines.push(`deleted: ${result.deleted.join(', ')}`);
    }
  } else {
    lines.push(`jobs: ${result.count}`);
  }
  for (const job of result.jobs ?? result.candidates ?? []) {
    lines.push(`- ${job.id} ${job.status}/${job.phase} ${job.updated_at ?? ''}`);
  }
  if (result.diagnostics?.length > 0) {
    lines.push('diagnostics:');
    for (const diagnostic of result.diagnostics) {
      lines.push(`- ${diagnostic.category}: ${diagnostic.message}`);
    }
  }
  lines.push(`next: ${result.next_step}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function writeChatText(result) {
  const lines = [];
  lines.push(`chat: ${result.completed ? 'completed' : 'not completed'}`);
  lines.push(`phase: ${result.phase}`);
  if (result.job_id) {
    lines.push(`job: ${result.job_id}`);
  }
  if (result.parent_job_id) {
    lines.push(`parent: ${result.parent_job_id}`);
  }
  if (typeof result.page_found === 'boolean') {
    lines.push(`page: ${result.page_found ? `found (${result.page_match ?? 'unknown'})` : 'not found'}`);
  }
  if (Number.isInteger(result.attachment_count)) {
    lines.push(`attachments: ${result.attachment_count}`);
  }
  if (result.model?.selected_label) {
    lines.push(`model: ${result.model.selected_label}`);
  }
  lines.push(`endpoint: ${result.endpoint ?? 'unavailable'}`);
  lines.push(`submitted: ${Boolean(result.submitted)}`);
  if (result.response?.text) {
    lines.push('response:');
    lines.push(result.response.text);
  }
  if (result.diagnostics?.length > 0) {
    lines.push('diagnostics:');
    for (const diagnostic of result.diagnostics) {
      lines.push(`- ${diagnostic.category}: ${diagnostic.message}`);
    }
  }
  lines.push(`next: ${result.next_step}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function writeImageText(result) {
  const lines = [];
  lines.push(`image: ${result.completed ? 'completed' : 'not completed'}`);
  lines.push(`phase: ${result.phase}`);
  if (result.job_id) {
    lines.push(`job: ${result.job_id}`);
  }
  if (Number.isInteger(result.attachment_count)) {
    lines.push(`attachments: ${result.attachment_count}`);
  }
  if (result.model?.selected_label) {
    lines.push(`model: ${result.model.selected_label}`);
  }
  lines.push(`endpoint: ${result.endpoint ?? 'unavailable'}`);
  lines.push(`submitted: ${Boolean(result.submitted)}`);
  lines.push(`artifacts: ${result.artifact_count ?? 0}`);
  if (Number.isInteger(result.new_artifact_count)) {
    lines.push(`new artifacts: ${result.new_artifact_count}`);
  }
  if (Number.isInteger(result.uncollected_artifact_count)) {
    lines.push(`uncollected artifacts: ${result.uncollected_artifact_count}`);
  }
  if (typeof result.generating === 'boolean') {
    lines.push(`generating: ${result.generating}`);
  }
  if (typeof result.can_collect === 'boolean') {
    lines.push(`can collect: ${result.can_collect}`);
  }
  if (typeof result.can_revise === 'boolean') {
    lines.push(`can revise: ${result.can_revise}`);
  }
  if (result.output_dir) {
    lines.push(`output: ${result.output_dir}`);
  }
  for (const artifact of result.artifacts ?? []) {
    lines.push(`- ${artifact.filename} ${artifact.bytes} bytes`);
  }
  if (result.diagnostics?.length > 0) {
    lines.push('diagnostics:');
    for (const diagnostic of result.diagnostics) {
      lines.push(`- ${diagnostic.category}: ${diagnostic.message}`);
    }
  }
  lines.push(`next: ${result.next_step}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function writeDiscoverText(result) {
  const lines = [];
  lines.push(`discover: ${result.ready ? 'ready' : 'not ready'}`);
  lines.push(`endpoint: ${result.endpoint ?? 'unavailable'}`);
  lines.push(`pages: ${result.pages?.length ?? 0}`);
  for (const page of result.pages ?? []) {
    lines.push(`- ${page.openai_surface}: ${page.session_state} ${page.url}`);
    const available = (page.capabilities ?? []).map((capability) => capability.name);
    if (available.length > 0) {
      lines.push(`  capabilities: ${available.join(', ')}`);
    }
  }
  if (result.diagnostics?.length > 0) {
    lines.push('diagnostics:');
    for (const diagnostic of result.diagnostics) {
      lines.push(`- ${diagnostic.category}: ${diagnostic.message}`);
    }
  }
  lines.push(`next: ${result.next_step}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function writeBrowserText(result) {
  const lines = [];
  if (result.command === 'browser launch') {
    lines.push(`browser: ${result.ready || result.already_running ? 'ready' : 'not ready'}`);
    lines.push(`launched: ${Boolean(result.launched)}`);
    lines.push(`endpoint: ${result.endpoint ?? 'unavailable'}`);
    lines.push(`profile: ${result.profile_dir ?? 'unavailable'}`);
    lines.push(`pid: ${result.pid ?? 'unavailable'}`);
  } else if (result.command === 'browser stop') {
    lines.push(`stopped: ${Boolean(result.stopped)}`);
    lines.push(`endpoint: ${result.endpoint ?? 'unavailable'}`);
    lines.push(`pid: ${result.pid ?? 'unavailable'}`);
  }

  if (result.diagnostics?.length > 0) {
    lines.push('diagnostics:');
    for (const diagnostic of result.diagnostics) {
      lines.push(`- ${diagnostic.category}: ${diagnostic.message}`);
    }
  }
  lines.push(`next: ${result.next_step}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}
