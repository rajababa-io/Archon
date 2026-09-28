import { parseGateDiscovery, type GateRecord } from '../../.shared/gate.ts';
import { emit, text } from '../../.shared/io.ts';

// Each branch is certified by its producing node's schema. Exactly one runs.
const comparison: unknown = JSON.parse(text(process.env.INPUTS_COMPARISON));
const validation: unknown = JSON.parse(text(process.env.INPUTS_VALIDATION));
if ((comparison === null) === (validation === null)) {
  throw new Error('Validation requires exactly one executed path.');
}
if (comparison !== null) {
  emit(comparison);
} else if (typeof validation === 'object' && validation !== null) {
  // The agent classifies the recorded gate; it cannot certify one that did not pass.
  if ((validation as { green?: unknown }).green === true) {
    const discovery = parseGateDiscovery(JSON.parse(text(process.env.INPUTS_DISCOVERY)) as unknown);
    const gate = JSON.parse(text(process.env.INPUTS_GATE)) as GateRecord;
    const passed = gate.ran && gate.exit_code === 0 && !gate.timed_out && gate.error === '';
    if (!passed && !(discovery.gate === 'none_defined' && !gate.ran)) {
      throw new Error(
        `Validation declared green but the recorded gate did not pass: discovery ${discovery.gate}, ran ${gate.ran}, exit code ${gate.exit_code}, timed out ${gate.timed_out}, error ${JSON.stringify(gate.error)}.`
      );
    }
  }
  emit({ ...validation, evidence: null });
}
