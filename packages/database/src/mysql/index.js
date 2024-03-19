const mysql = require('mysql2')

class MyslAdapter {
    db
    listHistory = []
    credentials = { host: null, user: null, database: null, password: null }

    constructor(_credentials) {
        this.credentials = _credentials
        this.init().then()
    }

    async init() {
        this.db = mysql.createConnection(this.credentials)

        await this.db.connect(async (error) => {
            if (!error) {
                console.log(`Solicitud de conexión a base de datos exitosa`)
                await this.checkTableExists()
            }

            if (error) {
                console.log(`Solicitud de conexión fallida ${error.stack}`)
            }
        })
    }

    getPrevByNumber = async (from) => {
        if (this.db._closing) await this.init()
        return await new Promise((resolve, reject) => {
            const sql = `SELECT * FROM history WHERE phone='${from}' ORDER BY id DESC`
            this.db.query(sql, (error, rows) => {
                if (error) {
                    reject(error)
                }

                if (rows.length) {
                    const [row] = rows
                    row.options = JSON.parse(row.options)
                    resolve(row)
                }

                if (!rows.length) {
                    resolve(null)
                }
            })
        })
    }

    save = (ctx) => {
        const values = [
            [ctx.ref, ctx.keyword, ctx.answer, ctx.refSerialize, ctx.from, JSON.stringify(ctx.options)],
        ]
        const sql = 'INSERT INTO history (ref, keyword, answer, refSerialize, phone, options) values ?'

        this.db.query(sql, [values], (err) => {
            if (err) throw err
            console.log('Guardado en DB...', values)
        })
    }

    createTable = () =>
        new Promise((resolve) => {
            const tableName = 'history'

            const sql = `CREATE TABLE ${tableName} 
            (id INT AUTO_INCREMENT PRIMARY KEY, 
            ref varchar(255) NOT NULL,
            keyword varchar(255) NULL,
            answer longtext NOT NULL,
            refSerialize varchar(255) NULL,
            phone varchar(255) NOT NULL,
            options longtext NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) 
            CHARACTER SET utf8mb4 COLLATE utf8mb4_General_ci`

            this.db.query(sql, (err) => {
                if (err) throw err
                console.log(`Tabla ${tableName} creada correctamente `)
                resolve(true)
            })
        })

    checkTableExists = () =>
        new Promise((resolve) => {
            const sql = "SHOW TABLES LIKE 'history'"

            this.db.query(sql, (err, rows) => {
                if (err) throw err

                if (!rows.length) {
                    this.createTable()
                }

                resolve(!!rows.length)
            })
        })
}

module.exports = MyslAdapter
