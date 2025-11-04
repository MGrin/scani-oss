import type { UpdateUserInput } from '@scani/shared';
import { Container, Service } from 'typedi';
import type { User } from '../../domain/entities';
import { UserRepository } from '../../infrastructure/repositories/UserRepository';
import { BaseService } from './BaseService';

@Service()
export class UserService extends BaseService {
  private readonly userRepository = Container.get(UserRepository);

  constructor() {
    super('UserService');
  }

  async updateUser(userId: string, data: UpdateUserInput): Promise<User> {
    try {
      this.logInfo('Updating user', { userId, data });

      // Check if user exists
      const existingUser = await this.userRepository.findById(userId);
      this.assertExists(existingUser, `User with ID ${userId} not found`);

      // Update the user
      const updatedUser = await this.userRepository.update(userId, data);
      this.assertExists(updatedUser, 'Failed to update user');

      this.logInfo('User updated successfully', { userId: updatedUser.id });
      return updatedUser;
    } catch (error) {
      throw this.handleError(error, 'updateUser');
    }
  }

  async getUserById(userId: string): Promise<User | null> {
    try {
      return await this.userRepository.findById(userId);
    } catch (error) {
      throw this.handleError(error, 'getUserById');
    }
  }
}
