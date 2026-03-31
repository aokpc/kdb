const path = require('path');

module.exports = {
  target: 'node',
  entry: './src/web/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist', 'web'),
    filename: 'extension.js',
    libraryTarget: 'commonjs'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  externals: {
    vscode: 'commonjs vscode',
    "@serialport/bindings-cpp": 'commonjs @serialport/bindings-cpp',
    "node-gyp-build": 'commonjs node-gyp-build',
    
  },
  performance: {
    hints: false
  },
  devtool: 'nosources-source-map'
};
