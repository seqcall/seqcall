import { Controller } from '../framework/decorators';
import { UserDto } from '../domain/user-dto';
import { UserService } from '../services/user-service';
import { billingService } from '../services/billing-service';
import { formatName, slugify } from '../util/format';
import { Logger } from '../util/logger';

@Controller('/users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  async getUser(id: string): Promise<string> {
    this.validate(id);
    Logger.info(`getUser ${id}`);
    const user = await this.userService.findUser(id);
    const dto = new UserDto(user.name, formatName(user));
    const tags = ['a', 'b'].map((t) => slugify(t));
    return JSON.stringify({ dto, tags });
  }

  async renameUser(id: string, name: string): Promise<void> {
    this.validate(id);
    const user = await this.userService.rename(id, name);
    await billingService.bill(user, 1);
  }

  private validate(id: string): void {
    if (!id) {
      Logger.error('missing id');
    }
  }
}
