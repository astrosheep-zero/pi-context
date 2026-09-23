import test from "node:test";
import { installExtensionTestEnvironment } from "./extension.js";

export function installExtensionTestHooks(prefix: string) {
	const environment = installExtensionTestEnvironment(prefix);
	test.beforeEach(() => environment.beforeEach());
	test.afterEach(() => environment.afterEach());
	test.after(() => environment.dispose());
	return environment;
}
