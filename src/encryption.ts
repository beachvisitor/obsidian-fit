import FitPlugin from "../main";
import * as base64js from "base64-js";
import { deflate, inflate } from "pako";

export default class Encryption {
	plugin: FitPlugin;
	IV = new Uint8Array(16);

	constructor(plugin: FitPlugin) {
		this.plugin = plugin;
	}

	importKey = async (algorithm: string): Promise<CryptoKey> => {
		const hashBuffer = await crypto.subtle.digest(
			"SHA-256", new TextEncoder().encode(this.plugin.settings.key)
		);
		return await crypto.subtle.importKey(
			"raw",
			hashBuffer,
			algorithm,
			false,
			["encrypt", "decrypt"]
		);
	}

	generateIV = (): Uint8Array => {
		return crypto.getRandomValues(new Uint8Array(12))
	}

	encrypt = async (plainText: string): Promise<string> => {
		const key = await this.importKey("AES-GCM")
		const iv = this.generateIV()
		const encodedText = new TextEncoder().encode(plainText)
		const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encodedText)
		const combined = new Uint8Array(iv.byteLength + cipherBuffer.byteLength)
		combined.set(iv, 0)
		combined.set(new Uint8Array(cipherBuffer), iv.byteLength)
		return base64js.fromByteArray(combined)
	}

	decrypt = async (base64Content: string): Promise<string> => {
		const key = await this.importKey("AES-GCM")
		const combined = base64js.toByteArray(base64Content)
		const iv = combined.slice(0, 12)
		const ciphertext = combined.slice(12)
		const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)
		return new TextDecoder().decode(plainBuffer)
	}

	async encryptPath(path: string): Promise<string> {
		const compressed = deflate(new TextEncoder().encode(path));
		const encrypted = await crypto.subtle.encrypt(
			{ name: 'AES-CTR', counter: this.IV, length: 64 },
			await this.importKey('AES-CTR'),
			compressed
		);
		return this.arrayBufferToBase64Url(encrypted);
	}

	async decryptPath(data: string): Promise<string> {
		const encryptedBytes = this.base64UrlToArrayBuffer(data)
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-CTR', counter: this.IV, length: 64 },
			await this.importKey('AES-CTR'),
			encryptedBytes
		);
		const decompressed = inflate(new Uint8Array(decrypted));
		return new TextDecoder().decode(decompressed);
	}

	arrayBufferToBase64Url = (buffer: ArrayBuffer): string => {
		const uint8Array = new Uint8Array(buffer);
		let base64 = '';
		for (let i = 0; i < uint8Array.length; i++) {
			base64 += String.fromCharCode(uint8Array[i]);
		}
		return btoa(base64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	base64UrlToArrayBuffer = (base64Url: string): ArrayBuffer => {
		const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
		const binaryString = atob(base64);
		const buffer = new ArrayBuffer(binaryString.length);
		const view = new Uint8Array(buffer);
		for (let i = 0; i < binaryString.length; i++) {
			view[i] = binaryString.charCodeAt(i);
		}
		return buffer;
	}
}
