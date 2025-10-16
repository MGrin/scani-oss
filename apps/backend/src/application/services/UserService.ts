import { Container, Service } from 'typedi';
import type { CreateUserInput, UpdateUserInput } from '../../domain/dtos/user';
import type { User } from '../../domain/entities';
import { UserRepository } from '../../infrastructure/repositories/UserRepository';
import { BaseService } from './BaseService';

/**
 * UserService
 *
 * Handles all business logic related to user management including:
 * - User creation and updates
 * - User profile management
 * - User validation
 * - User deletion
 */
@Service()
export class UserService extends BaseService {
  private readonly userRepository = Container.get(UserRepository);

  constructor() {
    super('UserService');
  }

  /**
   * Create a new user
   *
   * @param data - User creation data
   * @returns Created user entity
   * @throws Error if user already exists or validation fails
   */
  async createUser(data: CreateUserInput): Promise<User> {
    try {
      this.logInfo('Creating new user', { email: data.email, name: data.name });

      // Validate required fields
      this.validateRequiredFields(data, ['email', 'name']);
      this.validateNonEmptyString(data.email, 'email');
      this.validateNonEmptyString(data.name, 'name');

      // Check if user already exists
      const existingByEmail = await this.userRepository.findByEmail(data.email);
      if (existingByEmail) {
        throw new Error(`User with email ${data.email} already exists`);
      }

      // Create the user
      const user = await this.userRepository.create({
        email: data.email,
        name: data.name,
        avatar: data.avatar || null,
        baseCurrencyId: data.baseCurrencyId || null,
      });

      this.logInfo('User created successfully', { userId: user.id });
      return user;
    } catch (error) {
      throw this.handleError(error, 'createUser');
    }
  }

  /**
   * Update an existing user
   *
   * @param userId - ID of the user to update
   * @param data - User update data
   * @returns Updated user entity
   * @throws Error if user not found or validation fails
   */
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

  /**
   * Get user profile by ID
   *
   * @param userId - ID of the user
   * @returns User entity
   * @throws Error if user not found
   */
  async getUserById(userId: string): Promise<User> {
    try {
      const user = await this.userRepository.findById(userId);
      this.assertExists(user, `User with ID ${userId} not found`);

      return user;
    } catch (error) {
      throw this.handleError(error, 'getUserById');
    }
  }

  /**
   * Get user profile by email
   *
   * @param email - Email of the user
   * @returns User entity
   * @throws Error if user not found
   */
  async getUserByEmail(email: string): Promise<User> {
    try {
      this.validateNonEmptyString(email, 'email');

      const user = await this.userRepository.findByEmail(email);
      this.assertExists(user, `User with email ${email} not found`);

      return user;
    } catch (error) {
      throw this.handleError(error, 'getUserByEmail');
    }
  }

  /**
   * Delete a user
   *
   * @param userId - ID of the user to delete
   * @returns true if deletion was successful
   * @throws Error if user not found or deletion fails
   */
  async deleteUser(userId: string): Promise<boolean> {
    try {
      this.logInfo('Deleting user', { userId });

      // Check if user exists
      const existingUser = await this.userRepository.findById(userId);
      this.assertExists(existingUser, `User with ID ${userId} not found`);

      // Delete the user
      const deleted = await this.userRepository.delete(userId);

      if (deleted) {
        this.logInfo('User deleted successfully', { userId });
      } else {
        throw new Error('Failed to delete user');
      }

      return deleted;
    } catch (error) {
      throw this.handleError(error, 'deleteUser');
    }
  }

  /**
   * Get all users (with optional pagination)
   *
   * @param limit - Maximum number of users to return
   * @param offset - Number of users to skip
   * @returns Array of user entities
   */
  async getAllUsers(limit?: number, offset?: number): Promise<User[]> {
    try {
      this.logDebug('Fetching all users', { limit, offset });
      return await this.userRepository.findAll({ limit, offset });
    } catch (error) {
      throw this.handleError(error, 'getAllUsers');
    }
  }

  /**
   * Check if a user exists by email
   *
   * @param email - Email to check
   * @returns true if user exists, false otherwise
   */
  async userExistsByEmail(email: string): Promise<boolean> {
    try {
      this.validateNonEmptyString(email, 'email');
      const user = await this.userRepository.findByEmail(email);
      return user !== null;
    } catch (error) {
      throw this.handleError(error, 'userExistsByEmail');
    }
  }
}
