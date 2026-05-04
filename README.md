# TypeGist

This creates a single d.ts file that gives bird-eye-view of the repo.

```
// ./src/world/WorldEngine.ts
export declare function makeWorldEngine<WorldType extends World = World>({ world, playscripts, plugins }: {
    world: WorldType;
    playscripts?: Playscript[];
    plugins?: Plugin<WorldType>[];
}): {
    update(deltaSec: number): void;
    dangerouslyGetState(): WorldType;
};

// ./src/world/updateWorld.ts
export declare function updateWorld<WorldType extends World>(world: WorldType, ctx: WorldContext<WorldType>, deltaSec: number): WorldType;

// ./src/plugin/processPlugins.ts
export declare function processPlugins<WorldType extends World = World>(plugins: Plugin<WorldType>[]): {
    beforeUpdateWorld(state: WorldType, deltaMs: number): void;
    afterUpdateWorld(state: WorldType, deltaMs: number): void;
};
```