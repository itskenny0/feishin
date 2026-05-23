// NOTE: This barrel must not eagerly read `controller`. When the cache
// subsystem (eagerly imported by app.tsx) pulls in `api/controller`, that
// module's evaluation can transitively re-enter this barrel before its
// `export const controller = …` has been assigned, producing a TDZ
// "Cannot access 'controller' before initialization" runtime error that
// blanks the whole app. Using a getter defers the binding read until the
// app code actually touches `api.controller`, by which point the
// controller module has finished evaluating.
import * as controllerModule from '/@/renderer/api/controller';

export const api = {
    get controller() {
        return controllerModule.controller;
    },
};
