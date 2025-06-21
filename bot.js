require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const XLSX = require('xlsx');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const axios = require('axios');

const usersPath = './users.json';

// Load users data
let userData = { admins: [], users: [] };
try {
    userData = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
} catch (err) {
    fs.writeFileSync(usersPath, JSON.stringify(userData));
}

// Initialize bot with token from environment variables
const bot = new Telegraf(process.env.BOT_TOKEN);

// Add rate limiting utility
class RateLimiter {
    constructor(interval = 3000) {
        this.queue = [];
        this.processing = false;
        this.interval = interval;
        this.maxRetries = 5;
        this.backoffMultiplier = 1.5;
        this.timeout = 30000; // 30 seconds
    }

    async add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                task,
                resolve,
                reject,
                retries: 0,
                backoffTime: this.interval,
                startTime: Date.now()
            });
            if (!this.processing) {
                this.process();
            }
        });
    }

    async process() {
        if (this.queue.length === 0) {
            this.processing = false;
            return;
        }

        this.processing = true;
        const item = this.queue[0];

        try {
            const result = await item.task();
            item.resolve(result);
            this.queue.shift();
            if (this.queue.length > 0) {
                this.queue[0].backoffTime = this.interval;
            }
        } catch (error) {
            console.error('Rate limiter error:', error);
            item.retries++;
            
            if (item.retries >= this.maxRetries || Date.now() - item.startTime > this.timeout) {
                item.reject(error);
                this.queue.shift();
            } else {
                item.backoffTime *= this.backoffMultiplier;
                this.queue.push(this.queue.shift());
                await new Promise(resolve => setTimeout(resolve, item.backoffTime));
            }
        }

        const jitter = Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, this.interval + jitter));
        this.process();
    }
}

// Create rate limiter instance
const rateLimiter = new RateLimiter(3000);

// Helper function for sending files in groups with delay
async function sendFilesInGroups(ctx, files, caption = '') {
    const maxRetries = 5;
    const groupSize = 10;
    let successCount = 0;
    let failedFiles = [];

    try {
        await new Promise(resolve => setTimeout(resolve, 1000));

        for (let i = 0; i < files.length; i += groupSize) {
            const fileGroup = files.slice(i, i + groupSize);
            
            try {
                const mediaGroup = fileGroup.map(file => ({
                    type: 'document',
                    media: { source: file.path }
                }));

                let success = false;
                let retryCount = 0;
                let backoffTime = 3000;

                while (!success && retryCount < maxRetries) {
                    try {
                        await rateLimiter.add(async () => {
                            await new Promise(resolve => setTimeout(resolve, 500));
                            await ctx.telegram.sendMediaGroup(ctx.chat.id, mediaGroup);
                        });
                        success = true;
                        backoffTime = 3000;
                    } catch (error) {
                        retryCount++;
                        console.error(`Retry ${retryCount}/${maxRetries}:`, error);
                        backoffTime *= 1.5;
                        const jitter = Math.random() * 1000;
                        await new Promise(resolve => setTimeout(resolve, backoffTime + jitter));
                    }
                }

                if (success) {
                    successCount += fileGroup.length;
                    if (successCount % 30 === 0 || i + groupSize >= files.length) {
                        await ctx.reply(`📤 Progress: ${successCount}/${files.length} file terkirim...`);
                    }
                } else {
                    failedFiles.push(...fileGroup);
                    await ctx.reply(`⚠️ Gagal mengirim grup file ke-${Math.floor(i/groupSize) + 1}. Mencoba melanjutkan...`);
                }

            } catch (error) {
                console.error('Group send error:', error);
                failedFiles.push(...fileGroup);
            } finally {
                fileGroup.forEach(file => {
                    try {
                        if (fs.existsSync(file.path)) {
                            fs.unlinkSync(file.path);
                        }
                    } catch (e) {
                        console.error('File cleanup error:', e);
                    }
                });
            }

            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        await ctx.reply(
            `📊 Ringkasan Pengiriman:\n` +
            `✅ Berhasil: ${successCount} file\n` +
            `❌ Gagal: ${failedFiles.length} file\n` +
            `📦 Total Grup: ${Math.ceil(files.length/groupSize)}\n` +
            (failedFiles.length > 0 ? `\nSilakan coba kembali untuk file yang gagal.` : '')
        );

        return { successCount, failedFiles };

    } catch (error) {
        console.error('Send files error:', error);
        throw error;
    }
}

// File processing functions
function processTxtFile(content, prefix = 'Contact') {
    if (typeof content !== 'string') {
        throw new Error('Invalid content type. Expected string.');
    }
    
    const lines = content.split('\n')
        .map(line => line.trim())
        .filter(line => line && /\d/.test(line));
    
    const contacts = [];
    let counter = 1;
    
    for (let line of lines) {
        const phone = formatPhoneNumber(line);
        if (phone) {
            contacts.push({
                name: `${prefix} ${counter++}`,
                phone: phone
            });
        }
    }
    return contacts;
}

function processExcelFile(workbook, prefix = 'Contact') {
    if (!workbook || typeof workbook !== 'object') {
        throw new Error('Invalid workbook type. Expected object.');
    }

    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
    const contacts = [];
    let counter = 1;

    rawData.forEach(row => {
        if (Array.isArray(row)) {
            row.forEach(cell => {
                if (cell) {
                    const phone = formatPhoneNumber(cell.toString());
                    if (phone) {
                        contacts.push({
                            name: `${prefix} ${counter++}`,
                            phone: phone
                        });
                    }
                }
            });
        }
    });
    
    return contacts;
}

function processCsvContent(content, prefix = 'Contact') {
    if (typeof content !== 'string') {
        throw new Error('Invalid content type. Expected string.');
    }

    const lines = content.split('\n')
        .map(line => line.trim())
        .filter(line => line);
    
    const contacts = [];
    let counter = 1;
    
    lines.forEach(line => {
        const values = line.split(',').map(val => val.trim());
        values.forEach(value => {
            const phone = formatPhoneNumber(value);
            if (phone) {
                contacts.push({
                    name: `${prefix} ${counter++}`,
                    phone: phone
                });
            }
        });
    });
    
    return contacts;
}

function processVcfFile(content) {
    if (typeof content !== 'string') {
        throw new Error('Invalid content type. Expected string.');
    }

    const contacts = [];
    const vcards = content.split('BEGIN:VCARD');
    
    vcards.forEach(vcard => {
        if (!vcard.trim()) return;
        
        const phoneMatch = vcard.match(/TEL[^:]*:(.*)/i);
        if (phoneMatch) {
            const phone = formatPhoneNumber(phoneMatch[1]);
            const nameMatch = vcard.match(/FN:(.*)/i);
            const name = nameMatch ? nameMatch[1].trim() : null;
            
            if (phone) {
                contacts.push({
                    name: name || `Contact ${contacts.length + 1}`,
                    phone: phone
                });
            }
        }
    });
    
    return contacts;
}

function isValidPhoneNumber(value) {
    if (!value) return false;
    const cleaned = value.toString().replace(/[^\d]/g, '');
    return cleaned.length >= 10 && cleaned.length <= 15;
}

function formatPhoneNumber(value) {
    if (!value) return null;
    let phone = value.toString().replace(/[^\d]/g, '');
    if (phone.length < 10 || phone.length > 15) return null;
    return '+' + phone;
}

function generateVcf(contacts) {
    let vcfContent = '';
    
    contacts.forEach(contact => {
        // Handle emoji dan karakter khusus dalam nama kontak
        const escapedName = contact.name
            .replace(/[\\,;]/g, '\\$&')  // Escape karakter khusus VCF
            .replace(/\n/g, ' ')         // Ganti newline dengan spasi
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // Hapus karakter kontrol
            
        vcfContent += 'BEGIN:VCARD\n';
        vcfContent += 'VERSION:3.0\n';
        vcfContent += `FN:${escapedName}\n`;
        vcfContent += `TEL;TYPE=CELL:${contact.phone}\n`;
        vcfContent += 'END:VCARD\n';
    });
    
    return vcfContent;
}

// Add file name sanitizer function
function sanitizeFileName(fileName) {
    // Hapus karakter yang tidak diizinkan dalam nama file Windows
    return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        // Tambahkan validasi lain jika diperlukan
        .trim();
}

// Bot middleware
bot.use(session());

bot.use((ctx, next) => {
    if (!ctx.session) {
        ctx.session = {
            contacts: [],
            fileCount: 0,
            totalFiles: 0
        };
    }
    return next();
});

bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
    ctx.reply('An error occurred while processing your request.');
});

// Bot commands
bot.command('start', (ctx) => {
    ctx.reply(
        'Selamat datang! Saya bisa memproses file kontak anda (xlsx, csv, txt, atau vcf).\n\n' +
        'Panduan Penggunaan:\n' +
        '1. Kirim file kontak\n' +
        '2. Pilih perintah konversi yang diinginkan\n' +
        '3. Ulangi untuk file lain atau /clear untuk mulai baru\n\n' +
        'Perintah:\n' +
        '• /menu - Lihat semua perintah\n' +
        '• /clear - Hapus semua kontak yang sudah diproses'
    );
});

bot.command('menu', (ctx) => {
    ctx.reply(
`╔═══════════════════════
║ 📱 KONVERTER KONTAK - MENU FITUR
╠═══════════════════════
║ ✅ Kirim file kontak (xlsx, csv, txt, vcf)
║ ✅ Pilih perintah konversi
║ ✅ Ulangi untuk file lain atau /clear
╠═══════════════════════
║ 🔄 KONVERSI VCF
║ /cv <nama_kontak> <nomor_bagi> <nama_output> <nomor_awal>
║ /an <nama_admin> <jumlah_admin> <nama_navy> <jumlah_navy> <nama_output>
║ /pv <nama_file> <jumlah_bagi>
║ /gv <nama_file>
╠═══════════════════════
║ 📝 KONVERSI TXT
║ /pt <nama_file> <jumlah_bagi>
║ /gt <nama_file>
║ /ct <nama_file>
║ /vt <nama_file>
║ /xt <nama_file>
╠═══════════════════════
║ 🏷️ RENAME FILE VCF
║ Upload beberapa file VCF, lalu:
║ /rename <nama_baru>
║ (Akan dikirim ulang: nama_baru1.vcf, dst)
╠═══════════════════════
║ 👑 ADMIN CONVERT INTERAKTIF
║ /anc
║ (Input nomor admin satu per baris, lalu nama kontak, lalu nama file)
╠═══════════════════════
║ 👥 USER MANAGEMENT
║ /id
║ /add <user_id>
║ /remove <user_id>
╠═══════════════════════
║ 🧹 LAINNYA
║ /clear
╚═══════════════════════`
    );
});

// Add admin check function
function isAdmin(userId) {
    return userData.admins.includes(userId.toString());
}

// User management commands
bot.command('id', (ctx) => {
    const userId = ctx.from.id;
    ctx.reply(`🆔 ID Anda: ${userId}`);
});

bot.command('add', (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        return ctx.reply('❌ Perintah ini hanya untuk admin.');
    }

    const match = ctx.message.text.match(/^\/add\s+(\d+)/);
    if (!match) {
        return ctx.reply('Format: /add <user_id>');
    }

    const userId = match[1];
    if (!userData.users.includes(userId)) {
        userData.users.push(userId);
        fs.writeFileSync(usersPath, JSON.stringify(userData));
        ctx.reply(`✅ User ${userId} ditambahkan.`);
    } else {
        ctx.reply(`⚠️ User ${userId} sudah terdaftar.`);
    }
});

bot.command('remove', (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        return ctx.reply('❌ Perintah ini hanya untuk admin.');
    }

    const match = ctx.message.text.match(/^\/remove\s+(\d+)/);
    if (!match) {
        return ctx.reply('Format: /remove <user_id>');
    }

    const userId = match[1];
    const index = userData.users.indexOf(userId);
    if (index > -1) {
        userData.users.splice(index, 1);
        fs.writeFileSync(usersPath, JSON.stringify(userData));
        ctx.reply(`✅ User ${userId} dihapus.`);
    } else {
        ctx.reply(`⚠️ User ${userId} tidak ditemukan.`);
    }
});

// File conversion commands
bot.command('cv', async (ctx) => {
    if (!ctx.session?.contacts) {
        return ctx.reply('❌ Silakan kirim file kontak terlebih dahulu!');
    }

    const text = ctx.message.text;
    const match = text.match(/^\/cv\s+([^\d]+?)\s+(\d+)\s+([^\d]+?)\s+(\d+)\s*$/);

    if (!match) {
        return ctx.reply(
            'Format: /cv <nama_kontak> <nomor_bagi> <nama_output> <nomor_awal>\n' +
            'Contoh: /cv Member 3 Group 1\n\n' +
            'Hasil:\n' +
            '• Nama kontak: Member 1, Member 2, dst\n' +
            '• Dibagi: 3 file\n' +
            '• Nama file: Group 1.vcf dst\n' +
            '• Mulai dari: nomor 1'
        );
    }

    const contactPrefix = match[1].trim();
    const splitCount = parseInt(match[2]);
    const fileName = match[3].trim();
    const startNumber = parseInt(match[4]);

    if (splitCount < 1 || startNumber < 1) {
        return ctx.reply('❌ Nomor pembagi dan nomor awal harus lebih besar dari 0');
    }

    try {
        const contacts = ctx.session.contacts;
        const contactsPerFile = Math.floor(contacts.length / splitCount);
        const remainingContacts = contacts.length % splitCount;
        
        const contactGroups = [];
        let currentIndex = 0;
        
        for (let i = 0; i < splitCount; i++) {
            const groupSize = contactsPerFile + (i < remainingContacts ? 1 : 0);
            if (groupSize > 0) {
                contactGroups.push(contacts.slice(currentIndex, currentIndex + groupSize));
                currentIndex += groupSize;
            }
        }

        await ctx.reply('🔄 Memulai proses konversi...');

        const vcfFiles = contactGroups.map((group, i) => {            const fileNumber = startNumber + i;
            const vcfContent = generateVcf(group.map((contact, idx) => ({
                name: `${contactPrefix} ${idx + 1}`,
                phone: contact.phone
            })));
            const safeFileName = sanitizeFileName(`${fileName} ${fileNumber}`);
            const outputPath = `./${safeFileName}.vcf`;
            fs.writeFileSync(outputPath, vcfContent);
            return { path: outputPath, count: group.length };
        });

        const { successCount, failedFiles } = await sendFilesInGroups(ctx, vcfFiles);

        await ctx.reply(
            `✅ Konversi selesai!\n\n` +
            `📊 Ringkasan:\n` +
            `• Total Kontak: ${contacts.length}\n` +
            `• Berhasil Terkirim: ${successCount} file\n` +
            `• Gagal Terkirim: ${failedFiles.length} file\n` +
            `• Format Nama: ${contactPrefix} 1 sampai ${contactPrefix} ${contacts.length}\n` +
            `• Nama File: ${fileName} ${startNumber} sampai ${fileName} ${startNumber + vcfFiles.length - 1}\n` +
            `• Kontak per File: ~${contactsPerFile}`
        );

        ctx.session = null;

    } catch (error) {
        console.error('Conversion error:', error);
        ctx.reply('❌ Terjadi kesalahan saat konversi.');
        ctx.session = null;
    }
});

bot.command('an', async (ctx) => {
    if (!ctx.session?.contacts) {
        return ctx.reply('❌ Silakan kirim file kontak terlebih dahulu!');
    }

    const text = ctx.message.text;
    const singleMatch = text.match(/^\/an\s+([^\d]+?)\s+(\d+)\s+([^\d]+?)\s*$/);
    const dualMatch = text.match(/^\/an\s+([^\d]+?)\s+(\d+)\s+([^\d]+?)\s+(\d+)\s+([^\d]+?)\s*$/);

    if (!singleMatch && !dualMatch) {
        return ctx.reply(
            'Format:\n' +
            '1. Satu grup:\n' +
            '   /an <nama_grup> <jumlah> <nama_output>\n' +
            '   Contoh: /an Admin 5 Staff\n\n' +
            '2. Dua grup:\n' +
            '   /an <nama_admin> <jumlah_admin> <nama_navy> <jumlah_navy> <nama_output>\n' +
            '   Contoh: /an Admin 2 Navy 3 Staff'
        );
    }

    try {
        const contacts = ctx.session.contacts;
        let allContacts = [];
        let summary = '';

        if (singleMatch) {
            const groupPrefix = singleMatch[1].trim();
            const groupCount = parseInt(singleMatch[2]);
            const outputName = singleMatch[3].trim();

            if (groupCount < 1) {
                return ctx.reply('❌ Jumlah kontak harus lebih besar dari 0');
            }

            if (contacts.length < groupCount) {
                return ctx.reply(`❌ Jumlah kontak tidak mencukupi! Tersedia: ${contacts.length}, Dibutuhkan: ${groupCount}`);
            }

            allContacts = contacts.slice(0, groupCount).map((contact, idx) => ({
                name: `${groupPrefix} ${idx + 1}`,
                phone: contact.phone
            }));

            summary = `✅ Konversi selesai!\n\n` +
                     `📊 Ringkasan:\n` +
                     `• ${groupPrefix}: ${groupCount} kontak\n` +
                     `  Range: ${groupPrefix} 1 sampai ${groupPrefix} ${groupCount}\n\n` +
                     `• Nama File: ${outputName}.vcf\n` +
                     `• Total Kontak: ${groupCount}`;

            await ctx.reply('🔄 Memulai proses konversi...');
            const vcfContent = generateVcf(allContacts);
            const outputPath = `./${outputName}.vcf`;
            fs.writeFileSync(outputPath, vcfContent);

            await ctx.replyWithDocument(
                { source: outputPath },
                { caption: `📁 ${outputName}.vcf (${groupCount} kontak)` }
            );

            fs.unlinkSync(outputPath);
            await ctx.reply(summary);

        } else {
            const adminPrefix = dualMatch[1].trim();
            const adminCount = parseInt(dualMatch[2]);
            const navyPrefix = dualMatch[3].trim();
            const navyCount = parseInt(dualMatch[4]);
            const outputName = dualMatch[5].trim();

            if (adminCount < 1 || navyCount < 1) {
                return ctx.reply('❌ Jumlah admin dan navy harus lebih besar dari 0');
            }

            const totalNeeded = adminCount + navyCount;

            if (contacts.length < totalNeeded) {
                return ctx.reply(`❌ Jumlah kontak tidak mencukupi! Tersedia: ${contacts.length}, Dibutuhkan: ${totalNeeded}`);
            }

            const adminContacts = contacts.slice(0, adminCount).map((contact, idx) => ({
                name: `${adminPrefix} ${idx + 1}`,
                phone: contact.phone
            }));

            const navyContacts = contacts.slice(adminCount, adminCount + navyCount).map((contact, idx) => ({
                name: `${navyPrefix} ${idx + 1}`,
                phone: contact.phone
            }));

            allContacts = [...adminContacts, ...navyContacts];

            await ctx.reply('🔄 Memulai proses konversi...');

            const vcfContent = generateVcf(allContacts);
            const outputPath = `./${outputName}.vcf`;
            fs.writeFileSync(outputPath, vcfContent);

            await ctx.replyWithDocument(
                { source: outputPath },
                { caption: `📁 ${outputName}.vcf (${totalNeeded} kontak)` }
            );

            fs.unlinkSync(outputPath);

            await ctx.reply(
                `✅ Konversi selesai!\n\n` +
                `📊 Ringkasan:\n` +
                `• ${adminPrefix}: ${adminCount} kontak\n` +
                `  Range: ${adminPrefix} 1 sampai ${adminPrefix} ${adminCount}\n\n` +
                `• ${navyPrefix}: ${navyCount} kontak\n` +
                `  Range: ${navyPrefix} 1 sampai ${navyPrefix} ${navyCount}\n\n` +
                `• Nama File: ${outputName}.vcf\n` +
                `• Total Kontak: ${totalNeeded}`
            );
        }

        ctx.session = null;

    } catch (error) {
        console.error('Conversion error:', error);
        ctx.reply('❌ Terjadi kesalahan saat konversi.');
        ctx.session = null;
    }
});

bot.command('pt', async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(/^\/pt\s+([^\d]+?)\s+(\d+)\s*$/);

    if (!match) {
        return ctx.reply(
            'Format: /pt <nama_file> <jumlah_bagi>\n' +
            'Contoh: /pt kontak 3\n\n' +
            'Hasil: kontak 1.txt, kontak 2.txt, kontak 3.txt'
        );
    }

    const fileName = match[1].trim();
    const splitCount = parseInt(match[2]);

    if (splitCount < 1) {
        return ctx.reply('❌ Jumlah pembagian harus lebih besar dari 0');
    }

    if (!ctx.session?.contacts) {
        return ctx.reply('❌ Silakan kirim file kontak terlebih dahulu!');
    }

    try {
        const contacts = ctx.session.contacts;
        const contactsPerFile = Math.floor(contacts.length / splitCount);
        const remainingContacts = contacts.length % splitCount;

        const contactGroups = [];
        let currentIndex = 0;

        for (let i = 0; i < splitCount; i++) {
            const groupSize = contactsPerFile + (i < remainingContacts ? 1 : 0);
            if (groupSize > 0) {
                contactGroups.push(contacts.slice(currentIndex, currentIndex + groupSize));
                currentIndex += groupSize;
            }
        }

        await ctx.reply('🔄 Memulai proses pembagian TXT...');

        const txtFiles = contactGroups.map((group, i) => {            const safeFileName = sanitizeFileName(`${fileName} ${i + 1}`);
            const outputPath = `./${safeFileName}.txt`;
            const content = group.map(contact => contact.phone.substring(1)).join('\n');
            fs.writeFileSync(outputPath, content);
            return { path: outputPath, count: group.length };
        });

        const { successCount, failedFiles } = await sendFilesInGroups(ctx, txtFiles);

        await ctx.reply(
            `✅ Pembagian selesai!\n\n` +
            `📊 Ringkasan:\n` +
            `• Total Kontak: ${contacts.length}\n` +
            `• Berhasil Terkirim: ${successCount} file\n` +
            `• Gagal Terkirim: ${failedFiles.length} file\n` +
            `• Nama File: ${fileName} 1.txt sampai ${fileName} ${txtFiles.length}.txt\n` +
            `• Kontak per File: ~${contactsPerFile}`
        );

    } catch (error) {
        console.error('TXT split error:', error);
        ctx.reply('❌ Terjadi kesalahan saat membagi file.');
    }
});

bot.command('pv', async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(/^\/pv\s+([^\d]+?)\s+(\d+)\s*$/);

    if (!match) {
        return ctx.reply(
            'Format: /pv <nama_file> <jumlah_bagi>\n' +
            'Contoh: /pv kontak 3\n\n' +
            'Hasil: kontak 1.vcf, kontak 2.vcf, kontak 3.vcf'
        );
    }

    const fileName = match[1].trim();
    const splitCount = parseInt(match[2]);

    if (splitCount < 1) {
        return ctx.reply('❌ Jumlah pembagian harus lebih besar dari 0');
    }

    if (!ctx.session?.contacts) {
        return ctx.reply('❌ Silakan kirim file kontak terlebih dahulu!');
    }

    try {
        const contacts = ctx.session.contacts;
        const contactsPerFile = Math.floor(contacts.length / splitCount);
        const remainingContacts = contacts.length % splitCount;

        const contactGroups = [];
        let currentIndex = 0;

        for (let i = 0; i < splitCount; i++) {
            const groupSize = contactsPerFile + (i < remainingContacts ? 1 : 0);
            if (groupSize > 0) {
                contactGroups.push(contacts.slice(currentIndex, currentIndex + groupSize));
                currentIndex += groupSize;
            }
        }

        await ctx.reply('🔄 Memulai proses pembagian VCF...');

        const vcfFiles = contactGroups.map((group, i) => {            const safeFileName = sanitizeFileName(`${fileName} ${i + 1}`);
            const outputPath = `./${safeFileName}.vcf`;
            const vcfContent = generateVcf(group.map(c => ({
                name: c.name,
                phone: c.phone
            })));
            fs.writeFileSync(outputPath, vcfContent);
            return { path: outputPath, count: group.length };
        });

        const { successCount, failedFiles } = await sendFilesInGroups(ctx, vcfFiles);

        await ctx.reply(
            `✅ Pembagian selesai!\n\n` +
            `📊 Ringkasan:\n` +
            `• Total Kontak: ${contacts.length}\n` +
            `• Berhasil Terkirim: ${successCount} file\n` +
            `• Gagal Terkirim: ${failedFiles.length} file\n` +
            `• Nama File: ${fileName} 1.vcf sampai ${fileName} ${vcfFiles.length}.vcf\n` +
            `• Kontak per File: ~${contactsPerFile}`
        );

    } catch (error) {
        console.error('VCF split error:', error);
        ctx.reply('❌ Terjadi kesalahan saat membagi file.');
    }
});

bot.command('gt', async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(/^\/gt\s+([^\d]+?)\s*$/);

    if (!match) {
        return ctx.reply(
            'Format: /gt <nama_file>\n' +
            'Contoh: /gt kontak\n\n' +
            'Hasil: kontak.txt dengan semua nomor'
        );
    }

    if (!ctx.session?.contacts) {
        return ctx.reply('❌ Silakan kirim file kontak terlebih dahulu!');
    }

    try {
        const fileName = match[1].trim();
        const contacts = ctx.session.contacts;
        
        await ctx.reply('🔄 Memulai proses penggabungan TXT...');

        const outputPath = `./${fileName}.txt`;
        const content = contacts.map(contact => contact.phone.substring(1)).join('\n');
        fs.writeFileSync(outputPath, content);

        await ctx.replyWithDocument(
            { source: outputPath },
            { caption: `📁 ${fileName}.txt (${contacts.length} kontak)` }
        );

        fs.unlinkSync(outputPath);

        await ctx.reply(
            `✅ Penggabungan selesai!\n\n` +
            `📊 Ringkasan:\n` +
            `• Total Kontak: ${contacts.length}\n` +
            `• Nama File: ${fileName}.txt`
        );

    } catch (error) {
        console.error('TXT merge error:', error);
        ctx.reply('❌ Terjadi kesalahan saat menggabungkan file.');
    }
});

bot.command('gv', async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(/^\/gv\s+([^\d]+?)\s*$/);

    if (!match) {
        return ctx.reply(
            'Format: /gv <nama_file>\n' +
            'Contoh: /gv kontak\n\n' +
            'Hasil: kontak.vcf dengan semua kontak'
        );
    }

    if (!ctx.session?.contacts) {
        return ctx.reply('❌ Silakan kirim file kontak terlebih dahulu!');
    }

    try {
        const fileName = match[1].trim();
        const contacts = ctx.session.contacts;
        
        await ctx.reply('🔄 Memulai proses penggabungan VCF...');

        const outputPath = `./${fileName}.vcf`;
        const vcfContent = generateVcf(contacts);
        fs.writeFileSync(outputPath, vcfContent);

        await ctx.replyWithDocument(
            { source: outputPath },
            { caption: `📁 ${fileName}.vcf (${contacts.length} kontak)` }
        );

        fs.unlinkSync(outputPath);

        await ctx.reply(
            `✅ Penggabungan selesai!\n\n` +
            `📊 Ringkasan:\n` +
            `• Total Kontak: ${contacts.length}\n` +
            `• Nama File: ${fileName}.vcf`
        );

    } catch (error) {
        console.error('VCF merge error:', error);
        ctx.reply('❌ Terjadi kesalahan saat menggabungkan file.');
    }
});

// Direct conversion commands
bot.command('ct', async (ctx) => {
    try {
        const match = ctx.message.text.match(/^\/ct\s+([^\d]+?)\s*$/);
        if (!match) {
            return ctx.reply(
                'Format: /ct <nama_file>\n' +
                'Contoh: /ct kontak\n\n' +
                'Hasil: kontak.txt dengan nomor dari CSV'
            );
        }

        const fileName = match[1].trim();
        if (!ctx.session?.contacts) {
            return ctx.reply('❌ Silakan kirim file CSV terlebih dahulu!');
        }

        const outputPath = `./${fileName}.txt`;
        const content = ctx.session.contacts.map(c => c.phone.substring(1)).join('\n');
        fs.writeFileSync(outputPath, content);

        await ctx.replyWithDocument(
            { source: outputPath },
            { caption: `📁 ${fileName}.txt (${ctx.session.contacts.length} nomor)` }
        );
        fs.unlinkSync(outputPath);

    } catch (error) {
        ctx.reply('❌ Terjadi kesalahan saat konversi CSV ke TXT.');
    }
});

bot.command('vt', async (ctx) => {
    try {
        const match = ctx.message.text.match(/^\/vt\s+([^\d]+?)\s*$/);
        if (!match) {
            return ctx.reply(
                'Format: /vt <nama_file>\n' +
                'Contoh: /vt kontak\n\n' +
                'Hasil: kontak.txt dengan nomor dari VCF'
            );
        }

        const fileName = match[1].trim();
        if (!ctx.session?.contacts) {
            return ctx.reply('❌ Silakan kirim file VCF terlebih dahulu!');
        }

        const outputPath = `./${fileName}.txt`;
        const content = ctx.session.contacts.map(c => c.phone.substring(1)).join('\n');
        fs.writeFileSync(outputPath, content);

        await ctx.replyWithDocument(
            { source: outputPath },
            { caption: `📁 ${fileName}.txt (${ctx.session.contacts.length} nomor)` }
        );
        fs.unlinkSync(outputPath);

    } catch (error) {
        ctx.reply('❌ Terjadi kesalahan saat konversi VCF ke TXT.');
    }
});

bot.command('xt', async (ctx) => {
    try {
        const match = ctx.message.text.match(/^\/xt\s+([^\d]+?)\s*$/);
        if (!match) {
            return ctx.reply(
                'Format: /xt <nama_file>\n' +
                'Contoh: /xt kontak\n\n' +
                'Hasil: kontak.txt dengan nomor dari XLSX'
            );
        }

        const fileName = match[1].trim();
        if (!ctx.session?.contacts) {
            return ctx.reply('❌ Silakan kirim file XLSX terlebih dahulu!');
        }

        const outputPath = `./${fileName}.txt`;
        const content = ctx.session.contacts.map(c => c.phone.substring(1)).join('\n');
        fs.writeFileSync(outputPath, content);

        await ctx.replyWithDocument(
            { source: outputPath },
            { caption: `📁 ${fileName}.txt (${ctx.session.contacts.length} nomor)` }
        );
        fs.unlinkSync(outputPath);

    } catch (error) {
        ctx.reply('❌ Terjadi kesalahan saat konversi XLSX ke TXT.');
    }
});

// Clear command
bot.command('clear', (ctx) => {
    ctx.session = {
        contacts: [],
        fileCount: 0,
        totalFiles: 0
    };
    ctx.reply('🗑️ Sesi dibersihkan. Anda dapat mengirim file baru.');
});

// Document handler
bot.on('document', async (ctx) => {
    try {
        const file = await ctx.telegram.getFile(ctx.message.document.file_id);
        const filePath = file.file_path;
        const fileExt = path.extname(ctx.message.document.file_name).toLowerCase();
        
        if (!['.txt', '.xlsx', '.csv', '.vcf'].includes(fileExt)) {
            return ctx.reply('❌ Format file tidak valid. Harap kirim file .txt, .xlsx, .csv, atau .vcf');
        }

        await ctx.reply('📝 Memproses file...');

        const response = await axios({
            url: `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`,
            responseType: 'arraybuffer'
        });

        let newContacts = [];
        
        switch (fileExt) {
            case '.vcf':
                newContacts = processVcfFile(response.data.toString());
                // Simpan file VCF upload di session
                if (!ctx.session.uploadedVcfs) ctx.session.uploadedVcfs = [];
                // Simpan buffer dan nama file asli
                ctx.session.uploadedVcfs.push({
                    buffer: Buffer.from(response.data),
                    originalName: ctx.message.document.file_name
                });
                break;
            case '.txt':
                newContacts = processTxtFile(response.data.toString());
                break;
            case '.xlsx':
                newContacts = processExcelFile(XLSX.read(response.data));
                break;
            case '.csv':
                newContacts = processCsvContent(response.data.toString());
                break;
        }

        if (fileExt === '.vcf') {
            await ctx.reply(`✅ File VCF berhasil diupload. Untuk rename dan kirim ulang, gunakan perintah:\n/rename <nama_baru>\nContoh: /rename asu`);
        }

        if (newContacts.length === 0 && fileExt !== '.vcf') {
            return ctx.reply(`❌ Tidak ada nomor kontak yang valid dalam file: ${ctx.message.document.file_name}`);
        }

        if (fileExt !== '.vcf') {
            ctx.session.contacts = [...(ctx.session.contacts || []), ...newContacts];
            ctx.session.fileCount = (ctx.session.fileCount || 0) + 1;
        }

        if (fileExt !== '.vcf') {
            await ctx.reply(
                `╔═══════════════════════\n` +
                `║ 📱 KONVERTER KONTAK\n` +
                `╠═══════════════════════\n` +
                `║ ✅ File berhasil diproses\n` +
                `║ 📊 Total kontak: ${ctx.session.contacts.length}\n` +
                `╠═══════════════════════\n` +
                `║ 🔄 KONVERSI VCF\n` +
                `║ /cv » Bagi & Rename\n` +
                `║ /an » Admin & Navy\n` +
                `║ /pv » Bagi file\n` +
                `║ /gv » Gabung semua\n` +
                `╠═══════════════════════\n` +
                `║ 📝 KONVERSI TXT\n` +
                `║ /pt » Bagi nomor\n` +
                `║ /gt » Gabung semua\n` +
                `║ /ct » CSV ke TXT\n` +
                `║ /vt » VCF ke TXT\n` +
                `║ /xt » XLSX ke TXT\n` +
                `╠═══════════════════════\n` +
                `║ 👥 USER MANAGEMENT\n` +
                `║ /id  » Lihat ID\n` +
                `║ /add » Tambah user\n` +
                `║ /remove » Hapus user\n` +
                `╚═══════════════════════`
            );
        }

    } catch (error) {
        console.error('Error processing file:', error);
        ctx.reply('❌ Terjadi kesalahan saat memproses file. Silakan coba lagi.');
    }
});

// Command untuk rename dan kirim ulang file VCF hasil upload
bot.command('rename', async (ctx) => {
    const match = ctx.message.text.match(/^\/rename\s+(.+)$/);
    if (!match) {
        return ctx.reply('Format: /rename <nama_baru>\nContoh: /rename asu');
    }
    const newName = match[1].trim();
    if (!ctx.session.uploadedVcfs || ctx.session.uploadedVcfs.length === 0) {
        return ctx.reply('❌ Tidak ada file VCF yang diupload. Silakan upload file VCF terlebih dahulu.');
    }
    // Kirim ulang file dengan nama baru
    for (let i = 0; i < ctx.session.uploadedVcfs.length; i++) {
        const fileObj = ctx.session.uploadedVcfs[i];
        const safeFileName = sanitizeFileName(`${newName}${i + 1}.vcf`);
        // Simpan file sementara
        fs.writeFileSync(safeFileName, fileObj.buffer);
        await ctx.replyWithDocument({ source: safeFileName }, { caption: `📁 ${safeFileName}` });
        fs.unlinkSync(safeFileName);
    }
    // Bersihkan session agar tidak double kirim
    ctx.session.uploadedVcfs = [];
    await ctx.reply('✅ Semua file berhasil di-rename dan dikirim ulang.');
});

// Fitur interaktif untuk convert admin
bot.command('anc', async (ctx) => {
    ctx.session.adminConvertStep = 1;
    ctx.session.adminConvertData = {};
    await ctx.reply('Masukkan nomor admin (boleh lebih dari satu, pisahkan dengan koma atau spasi):');
});

bot.on('text', async (ctx, next) => {
    if (ctx.session && ctx.session.adminConvertStep) {
        const step = ctx.session.adminConvertStep;
        if (step === 1) {
            // Step 1: input nomor admin
            let numbers = ctx.message.text.split(/\r?\n/).map(n => n.trim()).filter(Boolean);
            numbers = numbers.map(n => n.replace(/[^\d+]/g, ''));
            numbers = numbers.filter(n => n.length >= 10 && n.length <= 15);
            if (numbers.length === 0) {
                return ctx.reply('Nomor admin tidak valid. Masukkan ulang, satu nomor per baris.');
            }
            ctx.session.adminConvertData.numbers = numbers;
            ctx.session.adminConvertStep = 2;
            return ctx.reply('Masukkan nama kontak admin (misal: Admin, 👑 Admin, dsb):');
        } else if (step === 2) {
            // Step 2: input nama kontak admin
            const name = ctx.message.text.trim();
            if (!name) return ctx.reply('Nama kontak admin tidak boleh kosong. Masukkan ulang:');
            ctx.session.adminConvertData.contactName = name;
            ctx.session.adminConvertStep = 3;
            return ctx.reply('Masukkan nama file output (tanpa .vcf, misal: admin, admin2024, dsb):');
        } else if (step === 3) {
            // Step 3: input nama file
            const fileName = ctx.message.text.trim();
            if (!fileName) return ctx.reply('Nama file tidak boleh kosong. Masukkan ulang:');
            ctx.session.adminConvertData.fileName = fileName;
            // Proses konversi
            const { numbers, contactName } = ctx.session.adminConvertData;
            const contacts = numbers.map((num, idx) => ({
                name: `${contactName} ${idx + 1}`,
                phone: num.startsWith('+') ? num : ('+' + num)
            }));
            const vcfContent = generateVcf(contacts);
            const safeFileName = sanitizeFileName(`${fileName}.vcf`);
            fs.writeFileSync(safeFileName, vcfContent);
            await ctx.replyWithDocument({ source: safeFileName }, { caption: `📁 ${safeFileName} (${contacts.length} admin)` });
            fs.unlinkSync(safeFileName);
            await ctx.reply('✅ File admin berhasil dibuat dan dikirim.');
            ctx.session.adminConvertStep = undefined;
            ctx.session.adminConvertData = undefined;
            return;
        }
        return;
    }
    return next();
});

bot.launch();

// Enable graceful stop
process.once('SIGINT', () => {
    console.log('Bot stopping...');
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    console.log('Bot stopping...');
    bot.stop('SIGTERM');
});

// Export utilities for testing
module.exports = {
    RateLimiter,
    sendFilesInGroups,
    processTxtFile,
    processExcelFile,
    processCsvContent,
    processVcfFile,
    isValidPhoneNumber,
    formatPhoneNumber,
    generateVcf
};
