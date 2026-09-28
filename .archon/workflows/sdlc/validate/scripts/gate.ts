import { GATE_DEADLINE_MS, parseGateDiscovery, runGate } from '../../.shared/gate.ts';
import { artifactsDir, emit, text } from '../../.shared/io.ts';

const discovery = parseGateDiscovery(JSON.parse(text(process.env.INPUTS_DISCOVERY)) as unknown);
emit(await runGate(process.cwd(), artifactsDir(), discovery, GATE_DEADLINE_MS));
