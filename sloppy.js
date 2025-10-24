
function doSloppily(whatToDoSloppily, whatToDoAfter) {
    whatToDoSloppily();
    whatToDoAfter();
}

function test(x) {
    console.log("SLOPPY CONTEXT");
    console.log("Is strict?", (function () { return !this; })()); // false = sloppy
    // debugger;
}

function createFunc(EditorState) {
    let previousCreate = EditorState.create;
    const func = function (config) {
        console.log("Callback! is strict?", (function () { return !this; })()); // false = sloppy
        test(EditorState.create);
        if (config?.extensions) {
            let globalExtensionSpec = config.extensions
            debugger;
        }
        // debugger;
        console.log(`Creating new state with ${config?.extensions}`);
        return previousCreate.call(EditorState, config);
    }

    return func;
}

export { test, createFunc }