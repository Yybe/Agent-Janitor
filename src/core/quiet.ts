// Imported before anything touches node:sqlite. Node's default warning printer is a
// bootstrap listener, so it has to come off before a filter can replace it.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});
