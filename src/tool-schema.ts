import { Type } from "@earendil-works/pi-ai";
export const nullableString = () => Type.Optional(Type.Union([Type.String(), Type.Null()]));
export const nullableInteger = () => Type.Optional(Type.Union([Type.Integer(), Type.Null()]));
export const positiveInteger = () => Type.Optional(Type.Integer({ minimum: 1 }));
export const cursor = () => Type.Optional(Type.Integer({ minimum: 0, description: "Continuation cursor: pass the previous next_cursor back unchanged, with the same filters and ordering. Omit to start. next_cursor is null only when the set is exhausted." }));
export const recentFirst = () => Type.Optional(Type.Boolean({ description: "Return newest-first. Only an explicit false returns oldest-first. Defaults to true." }));
export const role = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool"), Type.Literal("system"), Type.Literal("developer"), Type.Null()]);

