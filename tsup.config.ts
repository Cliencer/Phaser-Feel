import {defineConfig} from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      feedbacks: 'src/feedbacks.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ['phaser'],
    treeshake: true,
  },
  {
    entry: {'phaser-feel': 'src/index.ts'},
    format: ['iife'],
    globalName: 'PhaserFeel',
    outExtension: () => ({js: '.global.js'}),
    dts: false,
    sourcemap: true,
    clean: false,
    external: ['phaser'],
    treeshake: true,
  },
]);
