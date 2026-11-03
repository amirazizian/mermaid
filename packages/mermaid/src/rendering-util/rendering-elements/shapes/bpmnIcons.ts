import type { IconifyJSON } from '@iconify/types';

export const bpmnIcons: IconifyJSON = {
  prefix: 'bpmn',
  height: 24,
  width: 24,
  icons: {
    message: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.6" d="M3 6h18v12H3z"/><path class="bpmn-glyph-fold" fill="none" stroke="currentColor" stroke-width="1.6" d="m3 6 9 7 9-7"/>',
    },
    timer: {
      body: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M12 7v5l3.5 2.5"/><path stroke="currentColor" stroke-width="1.2" d="M12 3v1.5M21 12h-1.5M12 21v-1.5M3 12h1.5"/>',
    },
    error: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M4 21 9.5 6 13 12.5 20 4 14.5 19 11 12.5Z"/>',
    },
    escalation: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="m12 3 8 18-8-7-8 7z"/>',
    },
    signal: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M12 4 22 20H2z"/>',
    },
    conditional: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.6" d="M4 4h16v16H4z"/><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M7 9h10M7 12.5h10M7 16h10"/>',
    },
    link: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M3 9h10V5l8 7-8 7v-4H3z"/>',
    },
    compensation: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M11 6 3 12l8 6zM21 6l-8 6 8 6z"/>',
    },
    cancel: {
      body: '<path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="m5 5 14 14M19 5 5 19"/>',
    },
    terminate: {
      body: '<circle cx="12" cy="12" r="9" fill="currentColor"/>',
    },
    multiple: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="m12 3 8.5 6.2-3.2 10H6.7l-3.2-10z"/>',
    },
    user: {
      body: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
    },
    service: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M10.52 5.57 L10.59 3.11 L13.41 3.11 L13.48 5.57 L15.5 6.4 L17.29 4.72 L19.28 6.71 L17.6 8.5 L18.43 10.52 L20.89 10.59 L20.89 13.41 L18.43 13.48 L17.6 15.5 L19.28 17.29 L17.29 19.28 L15.5 17.6 L13.48 18.43 L13.41 20.89 L10.59 20.89 L10.52 18.43 L8.5 17.6 L6.71 19.28 L4.72 17.29 L6.4 15.5 L5.57 13.48 L3.11 13.41 L3.11 10.59 L5.57 10.52 L6.4 8.5 L4.72 6.71 L6.71 4.72 L8.5 6.4Z"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    },
    script: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M7.5 3.5H18c-2 2.4-2 5.1 0 8.5s2 6.1 0 8.5H7.5c2-2.4 2-5.1 0-8.5s-2-6.1 0-8.5Z"/><path stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M9.5 8h6M10.8 12h6M9.5 16h6"/>',
    },
    manual: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" d="M7 14V6.5a1.5 1.5 0 0 1 3 0V11V4.5a1.5 1.5 0 0 1 3 0V11V5.5a1.5 1.5 0 0 1 3 0V11.5V7.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.6 15.4a1.6 1.6 0 0 1 2.5-1.9L7 14.6"/>',
    },
    receive: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.6" d="M3 6h18v12H3z"/><path fill="none" stroke="currentColor" stroke-width="1.6" d="m3 6 9 7 9-7"/>',
    },
    send: {
      body: '<path fill="currentColor" d="M3 6h18v12H3z" opacity=".18"/><path fill="none" stroke="currentColor" stroke-width="1.6" d="M3 6h18v12H3z"/><path fill="none" stroke="currentColor" stroke-width="1.6" d="m3 6 9 7 9-7"/>',
    },
    rule: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.6" d="M3 5h18v14H3z"/><path stroke="currentColor" stroke-width="1.4" d="M3 9h18M3 13h18M8 9v10"/>',
    },
    loop: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M20 12a8 8 0 1 1-2.7-6"/><path fill="currentColor" d="M20 3.2v5.4h-5.4z"/>',
    },
    parallel: {
      body: '<path stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 4v16M12 4v16M18 4v16"/>',
    },
    sequential: {
      body: '<path stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16"/>',
    },
    'ad-hoc': {
      body: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M3 15c2.5-6 6-6 8.5 0S18 21 21 15"/>',
    },
    subprocess: {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.6" d="M3 3h18v18H3z"/><path stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 7v10M7 12h10"/>',
    },
    exclusive: {
      body: '<path stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="m6 6 12 12M18 6 6 18"/>',
    },
    'parallel-multiple': {
      body: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 5v14M5 12h14"/>',
    },
    inclusive: {
      body: '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2.4"/>',
    },
    'parallel-gateway': {
      body: '<path stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M12 4v16M4 12h16"/>',
    },
    'event-based': {
      body: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="12" r="6.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="m12 7.4 4 2.9-1.5 4.7h-5L8 10.3z"/>',
    },
    complex: {
      body: '<path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
    },
  },
};
