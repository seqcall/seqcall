/** All-static utility class: «static». */
export class Logger {
  static info(message: string): void {
    Logger.write('INFO', message);
  }

  static error(message: string): void {
    Logger.write('ERROR', message);
  }

  private static write(level: string, message: string): void {
    console.log(`[${level}] ${message}`);
  }
}
