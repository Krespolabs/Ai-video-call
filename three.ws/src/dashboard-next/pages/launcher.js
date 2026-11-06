// dashboard-next — Memetic Launcher.
//
// Wraps the personal launcher (preview-only autonomous coin launcher) in the
// universal dashboard shell. The launcher's markup + controller live in
// src/user-launcher.js; here we mount the shell, drop the markup into the
// <main> slot, and hand control to the controller.

import { mountShell } from '../shell.js';
import { LAUNCHER_MARKUP, initLauncher } from '../../user-launcher.js';

const main = await mountShell();
main.innerHTML = LAUNCHER_MARKUP;
initLauncher();
