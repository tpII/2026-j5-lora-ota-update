/** Photographs of the two board models, for the node strip and the connection graph. */
import type { BoardModel } from "$lib/console/console-event.ts";
import heltecV2Image from "../../assets/wifi-lora-32-v2-1.png";
import heltecV4Image from "../../assets/wifi-lora-32-v4-1.png";

export const BOARD_IMAGES: { readonly [Model in BoardModel]: string } = {
  V2: heltecV2Image,
  "V4.3": heltecV4Image,
};
