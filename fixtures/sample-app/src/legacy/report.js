import { formatName } from '../util/format';

/** Plain JavaScript class calling into the TypeScript code. */
export class ReportGenerator {
  /**
   * @param {import('../services/user-service').UserService} userService
   * @param {any} printer
   */
  constructor(userService, printer) {
    this.userService = userService;
    this.printer = printer;
  }

  /** @param {string} id */
  async generate(id) {
    const user = await this.userService.findUser(id);
    const line = formatName(user);
    this.printer.print(line);
    return line;
  }
}
