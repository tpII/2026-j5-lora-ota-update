<script lang="ts">
  import {
    BANDWIDTHS_KILOHERTZ,
    LOW_NOISE_AMPLIFIER_BOARD_MODELS,
    ON_AIR_BANDWIDTH_KILOHERTZ,
    ON_AIR_MAXIMUM_CENTER_MEGAHERTZ,
    ON_AIR_MAXIMUM_POWER_DBM,
    ON_AIR_MINIMUM_CENTER_MEGAHERTZ,
  } from "$lib/protocol/protocol-contract.ts";
  import { formatConjunction, formatLimit } from "$lib/utils/format.ts";

  const benchBandwidths = formatConjunction(
    BANDWIDTHS_KILOHERTZ.filter((value) => value !== ON_AIR_BANDWIDTH_KILOHERTZ).map(String),
  );
</script>

<!-- The channels that may go on air under ADR 0004, for every section that sets or tests a channel. -->
<p class="border-l-2 border-warn pl-3 text-sm text-ink">
  Con antena se usan solo canales de {ON_AIR_BANDWIDTH_KILOHERTZ} kHz centrados entre
  {formatLimit(ON_AIR_MINIMUM_CENTER_MEGAHERTZ, 2)} y {formatLimit(ON_AIR_MAXIMUM_CENTER_MEGAHERTZ, 2)} MHz,
  con unos {ON_AIR_MAXIMUM_POWER_DBM} dBm como máximo en el conector; los de {benchBandwidths} kHz quedan
  para el banco, con cable coaxial y atenuadores o cargas de 50 Ω. Nunca transmitir sin antena; sobre la
  mesa, potencia mínima y LNA de la {formatConjunction(LOW_NOISE_AMPLIFIER_BOARD_MODELS)} puenteado. El
  firmware no impone estos límites: la responsabilidad es del operador (ADR 0004).
</p>
