import chalk from "chalk";
import pupeteer from "puppeteer";

function sleep(ms: number) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export class ConEd {
	browser: pupeteer.Browser | undefined;
	refresh_interval_min = 15;
	db_store: ((raw_data: any) => Promise<any>) | undefined;

	public constructor(values: Partial<ConEd>) {
		Object.assign(this, values);
		if (!this.valid_config()) {
			return;
		}
	}

	valid_config(): boolean {
		const req_config = ["EMAIL", "PASSWORD", "MFA_SECRET", "ACCOUNT_UUID", "METER_NUM"];
		return req_config.every((config) => {
			if (!process.env[config]) {
				console.log(chalk.red(`${config} is not set in the .env config! Exiting...`));
				return false;
			}
			return true;
		});
	}

	async init(): Promise<void> {
		this.browser = await pupeteer.launch({
			defaultViewport: { width: 1920, height: 1080 },
			args: ["--no-sandbox", "--disable-setuid-sandbox"],
		});
	}
	async login(): Promise<void> {
		const page = await this.browser!.newPage();
		// Login to ConEd website
		await page.goto("https://www.coned.com/en/login");
		await page.type("#form-login-email", process.env.EMAIL!);
		await page.type("#form-login-password", process.env.PASSWORD!);
		await page.click("#form-login-remember-me");
		await page.click(".submit-button");
		// Wait for login to authenticate
		await sleep(5000);
		await page.screenshot({ path: "meter0.png" });
		// Enter in 2 factor auth code (see README for details)
		await page.type("#form-login-mfa-code", process.env.MFA_SECRET!);
		await page.click(".js-login-new-device-form .button");
		// Wait for authentication to complete
		await page.waitForNavigation();
		await sleep(5000);
		await page.screenshot({ path: "meter1.png" });
	}
	async read_api(): Promise<any> {
		return new Promise(async (resolve) => {
			// Access the API using your newly acquired authentication cookies!
			const api_page = await this.browser!.newPage();
			const api_url = `https://cned.opower.com/ei/edge/apis/cws-real-time-ami-v1/cws/cned/accounts/${process.env.ACCOUNT_UUID}/meters/${process.env.METER_NUM}/usage`;
			await api_page.goto(api_url);
			await api_page.screenshot({ path: "meter2.png" });
			const data_elem = await api_page.$("pre");
			const text_data = await api_page.evaluate((el: HTMLElement) => el.textContent, data_elem);
			const raw_data = JSON.parse(text_data!);
			await api_page.close();
			resolve(raw_data);
		});
	}
	async fetch_once(): Promise<void> {
		await this.init();
		await this.login();
		let raw_data = await this.read_api();
		let attempt = 1;
		while ("error" in raw_data && attempt < 5) {
			console.log(chalk.yellow("Failed to fetch data from API:", raw_data["error"]["details"]));
			raw_data = await this.read_api();
			await sleep(15000);
			attempt++;
		}
		if (attempt < 5) {
			console.log(chalk.green("Successfully retrieved API data!"));
			this.db_store!(raw_data);
		} else {
			console.log(chalk.red("Failed to retrieve API data:", raw_data["error"]));
		}
		await this.browser?.close();
	}
	monitor(interval_min = 15): void {
		this.fetch_once();
		setInterval(() => {
			this.fetch_once();
		}, interval_min * 60 * 1000);
	}
}
