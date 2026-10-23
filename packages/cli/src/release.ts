async function main(): Promise<void> {
  const name = process.execPath.slice(process.execPath.lastIndexOf("/") + 1);
  switch (name) {
    case "armoriq-agd":
      await import("@armorantigravity/daemon/main");
      break;
    case "armorantigravity":
      await import("./main.ts");
      break;
    default:
      throw new Error(`Unknown ArmorAntigravity executable: ${name}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
