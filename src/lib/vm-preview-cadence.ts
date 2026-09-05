export function vmPreviewCadenceMs(input: { humanHeld: boolean; botBusy: boolean }): number {
  if (input.humanHeld) return 650;
  return input.botBusy ? 3000 : 30_000;
}
