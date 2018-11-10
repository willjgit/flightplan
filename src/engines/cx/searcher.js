const { DateTime } = require('luxon')

const Searcher = require('../../Searcher')
const { cabins } = require('../../consts')

module.exports = class extends Searcher {
  async isLoggedIn (page) {
    // Sometimes the page keeps reloading out from under us
    return this.retry(async () => {
      try {
        await page.waitFor('li.member-login-section, li.member-section', { visible: true })
      } catch (err) {}
      return !!(await page.$('li.member-section'))
    })
  }

  async login (page, credentials) {
    const [ username, password ] = credentials
    if (!username || !password) {
      throw new Searcher.Error(`Missing login credentials`)
    }

    // Enter username and password
    await page.click('#memID')
    await this.clear('#memID')
    await page.keyboard.type(username, { delay: 10 })
    await page.click('#memPIN')
    await this.clear('#memPIN')
    await page.keyboard.type(password, { delay: 10 })
    await page.waitFor(250)

    // Check remember box
    if (!await page.$('#checkRememberMe:checked')) {
      await page.click('label[for=checkRememberMe]')
      await page.waitFor(250)
    }

    // Submit form
    await this.clickAndWait('#account-login div.form-login-wrapper button.btn-primary')
  }

  async search (page, query, results) {
    const { oneWay, fromCity, toCity, cabin, quantity } = query
    const departDate = query.departDateObject()
    const returnDate = query.returnDateObject()

    // Make sure destination city is cleared
    await this.clearCity('#input-destination')

    // Set from / to cities
    await this.setCity('#input-origin', '#results-origin', fromCity)
    await this.setCity('#input-destination', '#results-destination', toCity)

    // Set one-way / roundtrip
    await page.click(oneWay ? '#tab-itinerary-type-oneway span' : '#tab-itinerary-type-return span')
    await page.waitFor(500)

    // Set dates
    const dates = oneWay ? [departDate] : [departDate, returnDate]
    const selector = `div.travel-dates-${oneWay ? 'ow' : 'rt'}-wrapper`
    for (let i = 0; i < dates.length; i++) {
      // Check if calendar is visible
      try {
        await page.waitFor('#ui-datepicker-div', { visible: true, timeout: 2000 })
      } catch (err) {
        // Don't see calendar, open it up
        await page.click(`${selector} button:nth-of-type(${i + 1})`)
      }

      // Choose the date
      await this.setDate(dates[i])
    }

    // Set the cabin
    const cabinOptions = {
      [cabins.economy]: 'Y',
      [cabins.premium]: 'W',
      [cabins.business]: 'C',
      [cabins.first]: 'F'
    }
    if (!await this.select('#select-cabin', cabinOptions[cabin])) {
      throw new Searcher.Error(`Could not set cabin to: ${cabin}`)
    }

    // Set quantity
    await page.click('#btn-passengers')
    await page.waitFor('#select-adult', { visible: true })
    if (!await this.select('#select-adult', quantity.toString())) {
      throw new Searcher.Error(`Could not set # of adults to: ${quantity}`)
    }

    // Turn off flexible dates
    if (await page.$('#flexible-dates:checked')) {
      await page.click('label[for=flexible-dates]')
      await page.waitFor(250)
    }

    return this.submitForm(results)
  }

  async submitForm (results) {
    const { page } = this
    const pageBom = []
    const milesInfo = []

    let fn = null
    try {
      // Capture AJAX responses with pricing info
      fn = (response) => {
        if (response.url().includes('milesInfo')) {
          const contentLength = parseInt(response.headers()['content-length'])
          if (contentLength > 0) {
            response.json().then(x => {
              milesInfo.push(x)
            })
          }
        }
      }
      this.page.on('response', fn)

      // Submit search form
      const response = await Promise.race([
        this.clickAndWait('button.btn-facade-search'),
        this.page.waitFor('span.label-error', { visible: true, timeout: 0 })
      ])
      if (response && response.constructor.name !== 'ElementHandle') {
        this.checkResponse(response)
      }

      // Check for error messages
      const msg = await this.textContent('span.label-error')
      if (msg.length > 0 && !msg.includes('no flights available')) {
        // If session becomes invalid, logout
        if (msg.includes('please login again')) {
          await this.logout()
        }
        throw new Searcher.Error(msg)
      }

      // Click through each tab (to cover every cabin and tier)
      let idx = 0
      while (true) {
        // If there's a "No flights available" modal pop-up, dismiss it
        await this.clickIfVisible('#flights-not-available-modal button.btn-modal-close')

        // Make sure results have finished loading
        await this.settle()

        // // Insert a small wait (to simulate throttling between tabs)
        await this.waitBetween(4000, 6000)

        // Obtain flight data
        pageBom.push(await page.evaluate(() => window.pageBom))

        // Take a screenshot
        await results.screenshot(`results-${idx}`)

        // Find the next tab's selector
        idx++
        const tabSel = await this.nextTab()
        if (!tabSel) {
          break
        } else if (idx > 12) {
          throw new Searcher.Error('Too many award tabs detected')
        }

        // Click on the tab
        await page.click(tabSel)

        // Dismiss modal pop-up, warning us about changing award type
        await this.dismissWarning()
      }
    } finally {
      if (fn) {
        this.page.removeListener('response', fn)
      }
    }

    // Obtain JSON data from browser
    const json = await page.evaluate(() => {
      const { tiersListInbound, tiersListOutbound } = window
      return { tiersListInbound, tiersListOutbound }
    })
    json.pageBom = pageBom
    json.milesInfo = milesInfo.reduce((result, curr) => ({ ...result, ...curr.milesInfo }), {})

    // Save results
    return results.saveJSON('results', json)
  }

  async logout () {
    const { page } = this

    // Logout if possible
    const memberSel = 'li.member-section'
    const logoutSel = `${memberSel} button.circle-link-arrow-btn`
    try {
      await page.waitFor(memberSel, { visible: true, timeout: 1000 })
      await page.hover(memberSel)
      await page.waitFor(logoutSel, { visible: true, timeout: 1000 })
      await this.clickAndWait(logoutSel)
    } catch (err) {}
  }

  async nextTab () {
    const { page } = this

    // Calculate the index of the next tab (in same cabin) after currently selected one
    const tabIndex = await page.evaluate((itemSel, activeSel) => {
      let idx = 1
      let foundActive = false
      const activeTab = document.querySelector(activeSel)
      if (activeTab) {
        for (const item of document.querySelectorAll(itemSel)) {
          if (foundActive) {
            // This is the item after the active one
            return idx
          } else if (item.querySelector(activeSel)) {
            // This is the active item
            foundActive = true
          }
          idx++
        }
      }
      return 0
    }, '#flightlistDept div.owl-item', 'div.cabin-ticket-card-wrapper-outer.active')
    return tabIndex ? `div.owl-item:nth-of-type(${tabIndex}) div.cabin-ticket-card` : null
  }

  async dismissWarning () {
    const { page } = this

    // Warning modal present?
    try {
      await page.waitFor('#change-ticket-type-modal', { visible: true, timeout: 1000 })

      // Check the "Don't show again" box and dismiss
      if (await page.$('#change-ticket-type-dont-show-again:not(:checked)')) {
        await page.click('label[for=change-ticket-type-dont-show-again]')
        await page.waitFor(250)
      }
      await page.click('#change-ticket-type-modal button.btn-confirm')
    } catch (err) {}
  }

  async settle () {
    // Wait for spinner
    await this.monitor('.section-loading-overlay')
    await this.monitor('img.icon-loading')
  }

  async setCity (inputSel, selectSel, value) {
    const { page } = this
    await page.click(inputSel)
    await this.clear(inputSel)
    await page.waitFor(500)
    await page.keyboard.type(value, { delay: 100 })
    const itemSel = selectSel + ` li[data-airportcode=${value}]`
    await page.waitFor(itemSel, { visible: true, timeout: 10000 })
    await page.click(itemSel)
    await page.waitFor(500)
  }

  async clearCity (inputSel) {
    const { page } = this
    try {
      await page.waitFor(inputSel, { visible: true })
      await page.click(inputSel)
      await page.waitFor(500)
      await page.keyboard.press('Backspace')
      await page.waitFor(500)
    } catch (err) {}
  }

  async setDate (date) {
    let ret, direction

    // Move through the calendar page-by-page
    while (true) {
      // Check if the desired date is displayed
      ret = await this.chooseDate('.ui-datepicker-group-first', date)
      if (ret.error || ret.success) {
        return ret
      }
      const m1 = ret.month
      ret = await this.chooseDate('.ui-datepicker-group-last', date)
      if (ret.error || ret.success) {
        return ret
      }
      const m2 = ret.month

      // Should move left?
      let btnSel
      if (date < m1) {
        btnSel = '.ui-datepicker-group-first .ui-datepicker-prev'
      } else if (date > m2.endOf('month')) {
        btnSel = '.ui-datepicker-group-last .ui-datepicker-next'
      }
      if (btnSel) {
        if (direction && btnSel !== direction) {
          throw new Searcher.Error(`Infinite loop detected searching calendar for date: ${date}`)
        }
        ret = await this.changeMonth(btnSel, date)
        if (ret && ret.error) {
          return ret
        }
        direction = btnSel
      } else {
        throw new Searcher.Error(`Did not find date on active calendar pages: ${date}`)
      }
    }
  }

  async chooseDate (selector, date) {
    const { page } = this

    // Parse out the month first
    const str = await page.evaluate((sel) => {
      return document.querySelector(sel).textContent
    }, selector + ' .ui-datepicker-title')
    const month = DateTime.fromFormat(str.replace(/\s+/, ' '), 'LLL yyyy', { zone: 'utc' })

    // Does the date belong to this month?
    if (date.month !== month.month) {
      return { month, success: false }
    }

    // Find the right day, and click it
    for (const elem of await page.$$(selector + ' a')) {
      const text = await page.evaluate(x => x.textContent, elem)
      const elemDate = DateTime.fromFormat(text.replace(/\s+/, ' '), 'cccc LLLL d, yyyy', { zone: 'utc' })
      if (elemDate.isValid && elemDate.day === date.day) {
        // Found the date, click it!
        await elem.click()
        await page.waitFor(500)
        return { month, success: true }
      }
    }

    throw new Searcher.Error(`Date link not found within selected month: ${date}`)
  }

  async changeMonth (selector, date) {
    const { page } = this

    // Check if the desired link is not present
    if (!await page.$(selector)) {
      throw new Searcher.Error(`Requested month is outside of bounds: ${date}`)
    }
    await page.click(selector)
    await page.waitFor(500)
    return {}
  }
}
