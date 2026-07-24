const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/code.ts',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/
      },
      {
        // Webpack 5 native: import HTML file as a raw string
        test: /\.html$/,
        type: 'asset/source'
      }
    ]
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js']
  },
  output: {
    filename: 'code.js',
    path: path.resolve(__dirname, 'dist')
  },
  // Figma plugin runs in a sandboxed environment — tell webpack not to
  // polyfill Node.js built-ins (we don't use them)
  target: 'web'
};
