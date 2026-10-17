import type { z } from "zod";
import { KULE_TOOLS, type KuleToolName } from "@pilot/shared";

type Def<N extends KuleToolName> = (typeof KULE_TOOLS)[N];
export type KuleInput<N extends KuleToolName> = z.output<Def<N>["input"]>;
export type KuleOutput<N extends KuleToolName> = z.output<Def<N>["output"]>;
